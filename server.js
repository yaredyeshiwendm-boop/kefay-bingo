require('dotenv').config();

/**
 * Kefay Bingo — Server v5
 * Changes:
 *  - 80% winner / 20% house cut
 *  - Disqualification only notifies the cheater (silent to others)
 *  - Admin page (phone 251934255415 → admin)
 *  - Deposit/withdrawal requests with approve/reject
 *  - Full DB integration
 */

const express   = require('express');
const http      = require('http');
const WebSocket = require('ws');
const { v4: uuidv4 } = require('uuid');
const path      = require('path');

const app    = express();
const server = http.createServer(app);
const wss    = new WebSocket.Server({ server });
const PORT   = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, 'public')));
app.use('/audio', express.static(path.join(__dirname, 'audio')));
app.use(express.json());

const ADMIN_PHONE = '0993043478';
function isAdminPhone(phone) {
  if (!phone) return false;
  const normalized = String(phone).replace(/^\+/, '');
  return normalized === ADMIN_PHONE;
}
const HOUSE_CUT   = 0.20; // 20% house, 80% winner
// Prize pool that players actually see/win — total pot minus house cut
function prizePoolOf(room){ return Math.floor(room.pot*(1-HOUSE_CUT)); }

// ─── PAYMENT INFO (admin-editable) ────────────────────────

let PAYMENT_INFO = { telebirrNumber: '0940754834', telebirrName: 'Yared' };

// ─── DATABASE ─────────────────────────────────────────────────
let db = null;
if (process.env.DATABASE_URL) {
  try {
    const { Pool } = require('pg');
    const pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: { rejectUnauthorized: false },
      max: 10,                      // cap concurrent DB connections
      idleTimeoutMillis: 30000,     // close idle connections after 30s
      connectionTimeoutMillis: 30000, // allow more time for Render DB
      keepAlive: true,
      keepAliveInitialDelayMillis: 10000
    });

    db = {
      q: (sql, p) => pool.query(sql, p).then(r => r.rows),

      async getUser(tid) {
        const r = await this.q('SELECT * FROM users WHERE telegram_id=$1', [String(tid)]);
        return r[0] || null;
      },
      async getUserByPhone(phone) {
        const r = await this.q('SELECT * FROM users WHERE phone=$1', [phone]);
        return r[0] || null;
      },
      async createUser(tid, name, phone) {
  const referralCode = 'KF' + String(tid).slice(-8);

  const r = await this.q(
    `INSERT INTO users(
       telegram_id,
       name,
       phone,
       balance,
       referral_code
     )
     VALUES($1,$2,$3,10,$4)
     ON CONFLICT(telegram_id)
     DO UPDATE SET last_seen=NOW(), name=$2
     RETURNING *`,
    [String(tid), name, phone, referralCode]
  );

  return r[0];
},
      async setBalance(tid, bal) {
        await this.q('UPDATE users SET balance=$1 WHERE telegram_id=$2', [bal, String(tid)]);
      },
      async logTx(tid, type, amount, balAfter, ref) {
        await this.q(
          `INSERT INTO transactions(user_id,type,amount,balance_after,reference)
           SELECT id,$2,$3,$4,$5 FROM users WHERE telegram_id=$1`,
          [String(tid), type, amount, balAfter, ref || '']
        );
      },
      async saveGame(roomId, stakeId, amount, pot) {
        const r = await this.q(
          `INSERT INTO games(room_id,stake_id,stake_amount,pot,status,started_at)
           VALUES($1,$2,$3,$4,'playing',NOW()) RETURNING id`,
          [roomId, stakeId, amount, pot]
        );
        return r[0].id;
      },
        async addGameParticipant(gameId, tid, cardId, isDisqualified=false) {
          await this.q(
            `INSERT INTO game_participants (game_id, user_id, card_id, is_disqualified)
             SELECT $1, id, $3, $4
             FROM users WHERE telegram_id=$2
             ON CONFLICT (game_id, user_id)
             DO UPDATE SET card_id=EXCLUDED.card_id, is_disqualified=EXCLUDED.is_disqualified`,
            [gameId, String(tid), cardId, isDisqualified]
          );
        },

      async endGame(gameId, tids, winAmount, isSplit, called) {
        await this.q(
          `UPDATE games SET status='finished',winner_ids=$1,win_amount=$2,is_split=$3,called_numbers=$4,ended_at=NOW() WHERE id=$5`,
          [tids, winAmount, isSplit, called, gameId]
        );
        if (tids.length) {
          await this.q('UPDATE users SET total_wins=total_wins+1,total_winnings=total_winnings+$1 WHERE telegram_id=ANY($2)', [winAmount, tids]);
        }
        await this.q(`UPDATE users SET total_games=total_games+1 WHERE telegram_id=ANY(
          SELECT DISTINCT u.telegram_id FROM game_participants gp JOIN users u ON u.id=gp.user_id WHERE gp.game_id=$1)`, [gameId]);
      },

      // ── Deposits ──
      async createDeposit(tid, amount, txRef) {
        const r = await this.q(
          `INSERT INTO deposit_requests(user_id,amount,tx_ref,status)
           SELECT id,$2,$3,'pending' FROM users WHERE telegram_id=$1 RETURNING id`,
          [String(tid), amount, txRef]
        );
        return r[0]?.id;
      },
      async getDeposits(status) {
        const where = status ? 'WHERE dr.status=$1' : '';
        const params = status ? [status] : [];
        return this.q(
          `SELECT dr.*,u.name,u.phone,u.telegram_id FROM deposit_requests dr
           JOIN users u ON u.id=dr.user_id ${where} ORDER BY dr.created_at DESC LIMIT 50`, params
        );
      },
      async approveDeposit(id) {
        const r = await this.q(
          `UPDATE deposit_requests SET status='approved',approved_at=NOW() WHERE id=$1 AND status='pending' RETURNING *`, [id]
        );
        if (!r[0]) return null;
        const dep = r[0];
        // Credit balance
        const u = await this.q('SELECT telegram_id,balance FROM users WHERE id=$1', [dep.user_id]);
        if (u[0]) {
          const newBal = parseFloat(u[0].balance) + parseFloat(dep.amount);
          await this.setBalance(u[0].telegram_id, newBal);
          await this.logTx(u[0].telegram_id, 'deposit', dep.amount, newBal, dep.tx_ref);
          return { telegramId: u[0].telegram_id, newBalance: newBal, amount: dep.amount };
        }
        return null;
      },
      async rejectDeposit(id) {
        await this.q(`UPDATE deposit_requests SET status='rejected',approved_at=NOW() WHERE id=$1`, [id]);
      },

      // ── Withdrawals ──
      async createWithdrawal(tid, amount) {
        const u = await this.getUser(tid);
        if (!u || parseFloat(u.balance) < amount) return { error: 'Insufficient balance' };
        const newBal = parseFloat(u.balance) - amount;
        await this.setBalance(tid, newBal);
        await this.logTx(tid, 'withdrawal_pending', -amount, newBal, 'pending');
        const r = await this.q(
          `INSERT INTO withdrawal_requests(user_id,amount,status)
           SELECT id,$2,'pending' FROM users WHERE telegram_id=$1 RETURNING id`,
          [String(tid), amount]
        );
        return { id: r[0]?.id, newBalance: newBal };
      },
      async getWithdrawals(status) {
        const where = status ? 'WHERE wr.status=$1' : '';
        const params = status ? [status] : [];
        return this.q(
          `SELECT wr.*,u.name,u.phone,u.telegram_id FROM withdrawal_requests wr
           JOIN users u ON u.id=wr.user_id ${where} ORDER BY wr.created_at DESC LIMIT 50`, params
        );
      },
      async approveWithdrawal(id) {
        const r = await this.q(
          `UPDATE withdrawal_requests SET status='approved',handled_at=NOW() WHERE id=$1 AND status='pending' RETURNING *`, [id]
        );
        if (!r[0]) return null;
        const wr = r[0];
        const u = await this.q('SELECT telegram_id FROM users WHERE id=$1', [wr.user_id]);
        if (u[0]) await this.logTx(u[0].telegram_id, 'withdrawal', -wr.amount, 0, 'approved');
        return { telegramId: u[0]?.telegram_id, amount: wr.amount };
      },
      async rejectWithdrawal(id) {
        // Refund the balance
        const r = await this.q(
          `UPDATE withdrawal_requests SET status='rejected',handled_at=NOW() WHERE id=$1 AND status='pending' RETURNING *`, [id]
        );
        if (!r[0]) return null;
        const wr = r[0];
        const u = await this.q('SELECT telegram_id,balance FROM users WHERE id=$1', [wr.user_id]);
        if (u[0]) {
          const newBal = parseFloat(u[0].balance) + parseFloat(wr.amount);
          await this.setBalance(u[0].telegram_id, newBal);
          await this.logTx(u[0].telegram_id, 'withdrawal_refund', wr.amount, newBal, 'rejected');
          return { telegramId: u[0].telegram_id, newBalance: newBal };
        }
        return null;
      },

      // ── Admin user search ──
      async searchByPhone(phone) {
        return this.q(
          `SELECT u.*,
            (SELECT json_agg(t ORDER BY t.created_at DESC) FROM transactions t WHERE t.user_id=u.id) as transactions,
            (SELECT COUNT(*) FROM game_participants gp WHERE gp.user_id=u.id) as games_played
           FROM users u WHERE u.phone LIKE $1 LIMIT 10`,
          ['%' + phone + '%']
        );
      },

      async getLeaderboard() {
  return this.q('SELECT name,total_wins,total_games,total_winnings FROM users ORDER BY total_winnings DESC LIMIT 10');
},

// ── Super Bingo Board Reservations ──
async reserveSuperBoard(tid, cardId) {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const userResult = await client.query(
      `SELECT id, balance
       FROM users
       WHERE telegram_id=$1
       FOR UPDATE`,
      [String(tid)]
    );

    if (!userResult.rows[0]) {
      throw new Error('User not found');
    }

    const user = userResult.rows[0];
    const amount = 50;

    if (Number(user.balance) < amount) {
      throw new Error(`Need ${amount} ETB. Please deposit.`);
    }

    const reservationResult = await client.query(
      `INSERT INTO super_board_reservations
       (user_id, card_id, stake_amount, jackpot, status)
       VALUES ($1, $2, $3, 10000.00, 'locked')
       ON CONFLICT (card_id, status) DO NOTHING
       RETURNING *`,
      [user.id, cardId, amount]
    );

    if (!reservationResult.rows[0]) {
      throw new Error('Card already taken!');
    }

    const newBalance = Number(user.balance) - amount;

    await client.query(
      `UPDATE users
       SET balance=$1
       WHERE id=$2`,
      [newBalance, user.id]
    );

    await client.query('COMMIT');

    return {
      reservation: reservationResult.rows[0],
      balance: newBalance
    };

  } catch (e) {
    try {
      await client.query('ROLLBACK');
    } catch (_) {}

    throw e;

  } finally {
    client.release();
  }
},

async getUserSuperBoards(tid) {
  return this.q(
    `SELECT sbr.*
     FROM super_board_reservations sbr
     JOIN users u ON u.id=sbr.user_id
     WHERE u.telegram_id=$1
       AND sbr.status='locked'
     ORDER BY sbr.card_id`,
    [String(tid)]
  );
},

async getSuperBoardReservation(cardId) {
  const r = await this.q(
    `SELECT sbr.*, u.telegram_id
     FROM super_board_reservations sbr
     JOIN users u ON u.id=sbr.user_id
     WHERE sbr.card_id=$1
       AND sbr.status='locked'
     LIMIT 1`,
    [cardId]
  );
  return r[0] || null;
},

async lockSuperBoardForGame(cardId, gameId) {
  const r = await this.q(
    `UPDATE super_board_reservations
     SET status='playing', game_id=$1, played_at=NOW()
     WHERE card_id=$2
       AND status='locked'
     RETURNING *`,
    [gameId, cardId]
  );
  return r[0] || null;
},

async finishSuperBoard(cardId) {
  const r = await this.q(
    `UPDATE super_board_reservations
     SET status='finished'
     WHERE card_id=$1
       AND status='playing'
     RETURNING *`,
    [cardId]
  );
  return r[0] || null;
},

async releaseSuperBoard(tid, cardId) {
  const r = await this.q(
    `UPDATE super_board_reservations sbr
     SET status='released'
     FROM users u
     WHERE sbr.user_id=u.id
       AND u.telegram_id=$1
       AND sbr.card_id=$2
       AND sbr.status='locked'
     RETURNING sbr.*`,
    [String(tid), cardId]
  );
  return r[0] || null;
},

      // ── Settings (key/value store) ──
      async ensureSettingsTable() {
        await this.q(`CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT)`);
      },
      async getSetting(key) {
        const r = await this.q('SELECT value FROM settings WHERE key=$1', [key]);
        return r[0]?.value;
      },
      async setSetting(key, value) {
        await this.q(
          `INSERT INTO settings(key,value) VALUES($1,$2)
           ON CONFLICT(key) DO UPDATE SET value=$2`,
          [key, value]
        );
      }
    };

    pool.query('SELECT 1').then(async () => {
      console.log('✅ PostgreSQL connected');
      try {
        await db.ensureSettingsTable();
        const num  = await db.getSetting('telebirr_number');
        const name = await db.getSetting('telebirr_name');
        if (num)  PAYMENT_INFO.telebirrNumber = num;
        if (name) PAYMENT_INFO.telebirrName   = name;
      } catch (e) { console.error('⚠️ Settings load:', e.message); }

      // Clean up any games left in 'playing' state from a previous crashed session
      try {
        const stale = await db.q(
          `UPDATE games SET status='finished', ended_at=NOW(), win_amount=0
           WHERE status='playing' AND started_at < NOW() - INTERVAL '2 hours'
           RETURNING id`
        );
        if(stale.length) console.log(`🧹 Cleaned up ${stale.length} stale playing game(s):`, stale.map(r=>r.id));
      } catch(e) { console.error('⚠️ Stale game cleanup:', e.message); }
    }).catch(e => { console.error('❌ DB:', e.message); db = null; });
  } catch(e) { console.log('⚠️ pg error:', e.message); }
} else {
  console.log('ℹ️ No DATABASE_URL — memory mode');
}

// ─── CONFIG ──────────────────────────────────────────────────
const LOBBY_WAIT_MS    = 50000;
const CALL_INTERVAL_MS = 3000;
const CLAIM_WINDOW_MS  = 4800;
const CLAIM_COLLECT_MS = 700; // grace period to gather simultaneous BINGO claims
const NORMAL_TOTAL_CARDS = 400;
const SUPER_TOTAL_CARDS  = 1250;

const STAKES = [
  { id:'st10', amount:10, maxPlayers:400, type:'normal' },
  { id:'st20', amount:20, maxPlayers:400, type:'normal' },
  { id:'st50', amount:50, maxPlayers:400, type:'normal' },
  { id:'st100', amount:100, maxPlayers:400, type:'normal' },

  { id:'super50', amount:50, maxPlayers:1250, type:'super' },
];

// ─── SUPER BINGO SCHEDULE ───────────────────────────────────
const SUPER_DAY = [5, 6, 0]; // Friday, Saturday, Sunday
const SUPER_HOUR = 10;
const SUPER_MINUTE = 0;

function isSuperBingoTime(){
  const now = new Date();

  return (
    SUPER_DAY.includes(now.getDay()) &&
    now.getHours() === SUPER_HOUR &&
    now.getMinutes() === SUPER_MINUTE
  );
}
// ─── FIXED CARDS ─────────────────────────────────────────────
function seededRandom(seed) {
  let s = seed;
  return () => { s|=0; s=s+0x6D2B79F5|0; let t=Math.imul(s^s>>>15,1|s); t=t+Math.imul(t^t>>>7,61|t)^t; return((t^t>>>14)>>>0)/4294967296; };
}
function generateFixedCard(idx) {
  const rng=seededRandom(idx*7919), ranges=[[1,15],[16,30],[31,45],[46,60],[61,75]], nums=Array(25).fill(0);
  for(let col=0;col<5;col++){
    const[lo,hi]=ranges[col], pool=Array.from({length:hi-lo+1},(_,i)=>lo+i), picked=[];
    for(let i=0;i<5;i++){const j=Math.floor(rng()*pool.length);picked.push(pool.splice(j,1)[0]);}
    picked.sort((a,b)=>a-b);
    for(let row=0;row<5;row++){const ci=row*5+col; nums[ci]=ci===12?0:picked[row];}
  }
  return nums;
}
const NORMAL_CARD_POOL = [];
const SUPER_CARD_POOL = [];

for(let i=1;i<=NORMAL_TOTAL_CARDS;i++){
  NORMAL_CARD_POOL.push({
    id:i,
    numbers:generateFixedCard(i)
  });
}

for(let i=1;i<=SUPER_TOTAL_CARDS;i++){
  SUPER_CARD_POOL.push({
    id:i,
    numbers:generateFixedCard(i + 100000)
  });
}

const getCard = (id, type='normal') => {
  const pool = type === 'super' ? SUPER_CARD_POOL : NORMAL_CARD_POOL;
  return pool.find(c=>c.id===id);
};

// ─── WIN CHECK ───────────────────────────────────────────────
function checkWin(nums, called, marked) {
  const cs=new Set(called), ms=new Set(marked||[]); ms.add(12);
  const hit=i=>i===12||(cs.has(nums[i])&&ms.has(i));
  return [[0,1,2,3,4],[5,6,7,8,9],[10,11,12,13,14],[15,16,17,18,19],[20,21,22,23,24],
          [0,5,10,15,20],[1,6,11,16,21],[2,7,12,17,22],[3,8,13,18,23],[4,9,14,19,24],
          [0,6,12,18,24],[4,8,12,16,20],[0,4,20,24]].some(p=>p.every(i=>hit(i)));
}

// ─── STATE ───────────────────────────────────────────────────
const clients={}, rooms={}, userCache={};

// ─── USER HELPERS ────────────────────────────────────────────
async function loadUser(tid) {
  if(db){try{const u=await db.getUser(tid);if(u){userCache[tid] = { name: u.name, phone: u.phone, balance: parseFloat(u.balance), isAdmin: u.is_admin === true };}}catch(e){}}
  return userCache[tid]||null;
}
async function saveBalance(tid, bal) {
  if(userCache[tid]) userCache[tid].balance=bal;
  if(db&&tid){try{await db.setBalance(tid,bal);}catch(e){}}
}

// ─── ROOM HELPERS ────────────────────────────────────────────
function getOrCreateRoom(sid){
  let r=Object.values(rooms).find(r=>r.stakeId===sid&&(r.status==='waiting'||r.status==='countdown'));
  if(r) return r;
  const s=STAKES.find(s=>s.id===sid), roomId=uuidv4();
  r={
 roomId,
 stakeId:sid,
 stake:s.amount,
 gameType:s.type || 'normal',
 status:'waiting',players:[],calledNumbers:[],
     availableNumbers:Array.from({length:75},(_,i)=>i+1),callTimer:null,countdownTimer:null,claimEvalTimer:null,
     countdownLeft:Math.ceil(LOBBY_WAIT_MS/1000),claimWindowOpen:false,claimedThisRound:[],
     takenCardIds:new Set(),pot:0,dbGameId:null};
  rooms[roomId]=r; return r;
}
const send=(ws,msg)=>{if(ws&&ws.readyState===WebSocket.OPEN)ws.send(JSON.stringify(msg));};
const broadcast=(room,msg)=>{const s=JSON.stringify(msg);room.players.forEach(p=>{if(p.ws&&p.ws.readyState===WebSocket.OPEN)p.ws.send(s);});};
function broadcastLobby(){
  // Debounced: many joins/leaves happening in quick succession (busy lobby with
  // hundreds of players) will collapse into a single broadcast every 250ms,
  // instead of one full broadcast-to-everyone per event.
  if(broadcastLobby._pending) return;
  broadcastLobby._pending=true;
  setTimeout(()=>{
    broadcastLobby._pending=false;
    const payload=STAKES.map(s=>{const r=Object.values(rooms).find(r=>r.stakeId===s.id);
      return{stakeId:s.id,amount:s.amount,maxPlayers:s.maxPlayers,playerCount:r?r.players.length:0,status:r?r.status:'waiting',countdown:r&&r.status==='countdown'?r.countdownLeft:0};});
    const payloadStr=JSON.stringify({type:'lobbyUpdate',stakes:payload});
    Object.values(clients).forEach(c=>{if(!c.roomId&&c.ws&&c.ws.readyState===WebSocket.OPEN)c.ws.send(payloadStr);});
  },250);
}
function getRoomCardPool(room){
  return room.gameType === 'super'
    ? SUPER_CARD_POOL
    : NORMAL_CARD_POOL;
}

async function broadcastCardPool(room){
  const pool = getRoomCardPool(room);

  // Super Bingo: load ALL currently locked reservations
  // so every player can see which boards belong to someone else.
  let reservations = [];

  if(room.gameType==='super' && db){
    try{
      reservations = await db.q(`
        SELECT sbr.card_id, u.telegram_id
        FROM super_board_reservations sbr
        JOIN users u ON u.id=sbr.user_id
        WHERE sbr.status='locked'
      `);
    }catch(e){
      console.error('Super reservation pool error:',e.message);
    }
  }

  const reservationMap = new Map(
    reservations.map(r=>[
      Number(r.card_id),
      String(r.telegram_id)
    ])
  );

    console.log(
      '🔴 SUPER POOL:',
      reservations.map(r => ({
        cardId: Number(r.card_id),
        telegramId: String(r.telegram_id)
      }))
    );


  const cardCount = room.players.reduce(
    (sum,p) => sum + (p.cardId ? 1 : 0) + (p.cardId2 ? 1 : 0),
    0
  );

  room.players.forEach(p=>{
        if(ownerTid){ console.log("🔴 CARD", c.id, "OWNER:", ownerTid, "VIEWER:", myTid); }
    const myTid = String(p.telegramId || '');

    const reservedSuperBoards = reservations
      .filter(r=>String(r.telegram_id)===myTid)
      .map(r=>Number(r.card_id));

    send(p.ws,{
      type:'cardPoolUpdate',

      pool:pool.map(c=>{
        const ownerTid = reservationMap.get(Number(c.id));

        return {
          id:c.id,

          // Room state OR DB reservation
          taken:room.takenCardIds.has(c.id) || !!ownerTid,

          // Only this player's actual selected card is mine
          takenByMe:p.cardId===c.id || p.cardId2===c.id,

          // Explicit owner information for Super Bingo
          reservedByOther:
            !!ownerTid && ownerTid!==myTid,

          reservedByMe:
            !!ownerTid && ownerTid===myTid
        };
      }),

      reservedSuperBoards,

      playerCount:cardCount,
      stakeAmount:room.stake,
      gameType:room.gameType,
      totalCards:pool.length
    });
  });
}

// Lightweight update: tell everyone in the room only WHICH card(s) changed state,
// instead of re-sending the entire 400-card array on every single pick.
// This is the #1 fix for handling 400 concurrent players smoothly.
async function broadcastCardDiff(room, changedCardIds){
  const cardCount = room.players.reduce(
    (sum,p)=>(p.cardId?1:0)+(p.cardId2?1:0)+sum,
    0
  );

  // Load ALL active Super Bingo reservations
  let reservations = [];

  if(room.gameType==='super' && db){
    try{
      reservations = await db.q(`
        SELECT sbr.card_id, u.telegram_id
        FROM super_board_reservations sbr
        JOIN users u ON u.id=sbr.user_id
        WHERE sbr.status='locked'
      `);
    }catch(e){
      console.error('Super reservation diff error:',e.message);
    }
  }

  const reservationMap = new Map(
    reservations.map(r=>[
      Number(r.card_id),
      String(r.telegram_id)
    ])
  );

  for(const p of room.players){

    const myTid = String(p.telegramId || '');

    const reservedSuperBoards = reservations
      .filter(r=>String(r.telegram_id)===myTid)
      .map(r=>Number(r.card_id));

    const changes = changedCardIds.map(id=>{

      const ownerTid = reservationMap.get(Number(id));

      return {
        id,
        taken: room.takenCardIds.has(id) || !!ownerTid,
        takenByMe:
          p.cardId===id ||
          p.cardId2===id,

        reservedByOther:
          !!ownerTid && ownerTid!==myTid,

        reservedByMe:
          !!ownerTid && ownerTid===myTid
      };
    });

    send(p.ws,{
      type:'cardPoolDiff',
      changes,
      reservedSuperBoards,
      playerCount:cardCount,
      stakeAmount:room.stake,
      gameType:room.gameType,
      totalCards:
        room.gameType==='super'
          ? SUPER_TOTAL_CARDS
          : NORMAL_TOTAL_CARDS
    });
  }
}

// ─── GAME LIFECYCLE ──────────────────────────────────────────
function startCountdown(room){
  if(room.gameType==='super') return;

  // IMPORTANT: never create a second countdown for the same room
  if(room.status==='countdown' && room.countdownTimer) return;

  room.status='countdown';
  room.countdownLeft=Math.ceil(LOBBY_WAIT_MS/1000);

  // Send the initial value immediately to EVERY player
  broadcast(room,{
    type:'countdown',
    seconds:room.countdownLeft
  });

  room.countdownTimer=setInterval(()=>{
    if(room.status!=='countdown'){
      clearInterval(room.countdownTimer);
      room.countdownTimer=null;
      return;
    }

    const ready=room.players.filter(
      p=>p.cardId || p.cardId2
    ).length;

    if(ready<2){
      clearInterval(room.countdownTimer);
      room.countdownTimer=null;
      room.status='waiting';

      broadcast(room,{type:'waitingForPlayers'});
      broadcastLobby();
      return;
    }

    room.countdownLeft--;

    broadcast(room,{
      type:'countdown',
      seconds:Math.max(0,room.countdownLeft)
    });

    if(room.countdownLeft<=0){
      clearInterval(room.countdownTimer);
      room.countdownTimer=null;
      startGame(room);
    }
  },1000);
}

async function startGame(room){
  for(const p of room.players){
    if(!p.cardId&&!p.cardId2) continue; // spectator
    if(!p.hasPaid){
      const cl=clients[p.playerId];
      // Charge once per card selected
      const numCards=(p.cardId?1:0)+(p.cardId2?1:0);
      const totalCost=room.stake*numCards;
      if(cl&&cl.balance>=totalCost){
        cl.balance-=totalCost; p.hasPaid=true;
        await saveBalance(cl.telegramId,cl.balance);
        if(db&&cl.telegramId){try{await db.logTx(cl.telegramId,'stake',-totalCost,cl.balance,room.roomId);}catch(e){}}
        send(p.ws,{type:'balanceUpdate',balance:cl.balance});
      } else {
        // Can't afford — spectator
        if(p.cardId){room.takenCardIds.delete(p.cardId);p.cardId=null;}
        if(p.cardId2){room.takenCardIds.delete(p.cardId2);p.cardId2=null;}
        continue;
      }
    }
  }
  room.status='playing';
  // Count paid cards (each card = one stake)
   const paidCards=room.players.reduce(
  (s,p)=>s+(p.hasPaid?((p.cardId?1:0)+(p.cardId2?1:0)):0),
  0
);

const grossPot=paidCards*room.stake;

room.pot = room.gameType==='super'
  ? 10000
  : Math.floor(grossPot*(1-HOUSE_CUT));
  room.calledNumbers=[]; room.availableNumbers=Array.from({length:75},(_,i)=>i+1);
  room.claimedThisRound=[]; room.claimWindowOpen=false;
    if(db){
      try{
        room.dbGameId=await db.saveGame(room.roomId,room.stakeId,room.stake,grossPot);
          for(const p of room.players){
            if(!p.hasPaid) continue;
            const cl=clients[p.playerId];
            if(!cl || !cl.telegramId) continue;
            if(p.cardId){
              try{await db.addGameParticipant(room.dbGameId,cl.telegramId,p.cardId,p.disqualified);}catch(e){console.error("Participant card 1:",e.message);}
            }
            if(p.cardId2){
              try{await db.addGameParticipant(room.dbGameId,cl.telegramId,p.cardId2,p.disqualified);}catch(e){console.error("Participant card 2:",e.message);}
            }
          }
        if(room.gameType==="super"){
          for(const p of room.players){
            if(!p.hasPaid) continue;
            if(p.cardId){
              try{await db.lockSuperBoardForGame(p.cardId,room.dbGameId);}catch(e){console.error("Super card 1 lock:",e.message);}
            }
            if(p.cardId2){
              try{await db.lockSuperBoardForGame(p.cardId2,room.dbGameId);}catch(e){console.error("Super card 2 lock:",e.message);}
            }
          }
        }
      }catch(e){console.error("DB saveGame error:",e.message);}
    }

  room.players.forEach(p=>{
    if(p.cardId||p.cardId2){
      const card=p.cardId?getCard(p.cardId):null;
      const card2=p.cardId2?getCard(p.cardId2):null;
      send(p.ws,{type:'yourCard',
        cardId:p.cardId,cardNumbers:card?card.numbers:[],
        cardId2:p.cardId2||null,cardNumbers2:card2?card2.numbers:[],
        pot:room.pot,
playerCount:room.players.reduce(
  (sum,p)=>(p.cardId?1:0)+(p.cardId2?1:0)+sum,0
),
spectator:false});
    } else {
      send(p.ws,{type:'spectating',pot:room.pot,playerCount:room.players.filter(p=>p.hasPaid).length,calledNumbers:room.calledNumbers});
    }
  });

  broadcast(room,{type:'gameStart',pot:room.pot,players:room.players.map(p=>({playerId:p.playerId,playerName:p.playerName}))});
  broadcastLobby(); scheduleNextCall(room);
}
function checkSuperSchedule(){
  if(!isSuperBingoTime()) return;

  const superRoom = Object.values(rooms).find(
    r => r.gameType === 'super' &&
         r.status === 'waiting'
  );

  if(!superRoom) return;

  const readyPlayers = superRoom.players.filter(
    p => p.cardId || p.cardId2
  );

  if(readyPlayers.length === 0) return;

  console.log('🔥 SUPER BINGO scheduled start');

  startGame(superRoom);
}

// ─── SUPER BINGO AUTO SCHEDULER ─────────────────────────────
setInterval(() => {
  checkSuperSchedule();
}, 1000);

function scheduleNextCall(room){room.callTimer=setTimeout(()=>callNumber(room),CALL_INTERVAL_MS);}

function callNumber(room){
  if(room.status!=='playing') return;

  // FIX 1: Evaluate ALL pending claims BEFORE calling next number.
  // This lets multiple simultaneous winners be detected in the same window.
  if(room.claimedThisRound.length>0){evaluateClaims(room);return;}
  room.claimWindowOpen=false; room.claimedThisRound=[];
  if(room.availableNumbers.length===0){endGame(room,[],null,true);return;}
  const idx=Math.floor(Math.random()*room.availableNumbers.length);
  const drawn=room.availableNumbers.splice(idx,1)[0];
  room.calledNumbers.push(drawn);
  broadcast(room,{type:'numberCalled',number:drawn,calledNumbers:room.calledNumbers,callCount:room.calledNumbers.length,claimWindowMs:CLAIM_WINDOW_MS});
  room.claimWindowOpen=true; scheduleNextCall(room);
}

function evaluateClaims(room){
  room.claimEvalTimer=null;
  const winners=[], cheaters=[];
  room.claimedThisRound.forEach(claim=>{
    const p=room.players.find(p=>p.playerId===claim.playerId);
    if(!p||p.disqualified||(!p.cardId&&!p.cardId2)) return;
    // Check card 1
    const card1=p.cardId?getCard(p.cardId):null;
    const win1=card1&&checkWin(card1.numbers,room.calledNumbers,claim.markedIndices);
    // Check card 2
    const card2=p.cardId2?getCard(p.cardId2):null;
    const win2=card2&&checkWin(card2.numbers,room.calledNumbers,claim.markedIndices2);
    if(win1||win2) winners.push(p);
    else cheaters.push(p);
  });

  cheaters.forEach(p=>{
    p.disqualified=true;
    send(p.ws,{type:'disqualified',message:'🚫 False BINGO claim — you are disqualified!'});
  });

  room.claimedThisRound=[]; room.claimWindowOpen=false;

  if(winners.length>0) endGame(room,winners,null,false);
  else scheduleNextCall(room);
}

async function endGame(room, winners, customMsg, noWinner){
  if(room.callTimer) clearTimeout(room.callTimer);
  if(room.countdownTimer) clearInterval(room.countdownTimer);
  if(room.claimEvalTimer) clearTimeout(room.claimEvalTimer);
  room.status='finished'; room.claimWindowOpen=false;

  let winAmount=0, winnerNames=[], winnerTids=[];

  if(winners&&winners.length>0){
     const prizePool=room.pot;
    // Split prize pool equally among winners
    winAmount=Math.floor(prizePool/winners.length);
    winnerNames=winners.map(w=>w.playerName);
    for(const w of winners){
      const cl=clients[w.playerId];
      if(cl){
        cl.balance+=winAmount;
        winnerTids.push(cl.telegramId||'');
        await saveBalance(cl.telegramId,cl.balance);
        if(db&&cl.telegramId){try{await db.logTx(cl.telegramId,'win',winAmount,cl.balance,room.roomId);}catch(e){}}
        send(w.ws,{type:'balanceUpdate',balance:cl.balance});
      }
    }
  }

  if(db&&room.dbGameId){
    try{await db.endGame(room.dbGameId,winnerTids,winAmount,winners.length>1,room.calledNumbers);}
    catch(e){console.error('endGame DB error:',e.message);}
  if(db && room.gameType === 'super'){
    for(const p of room.players){
      if(p.cardId){
        try{
          await db.finishSuperBoard(p.cardId);
        }catch(e){
          console.error('Super card 1 finish:',e.message);
        }
      }
      if(p.cardId2){
        try{
          await db.finishSuperBoard(p.cardId2);
        }catch(e){
          console.error('Super card 2 finish:',e.message);
        }
      }
    }
  }

  } else if(db&&!room.dbGameId){
    // saveGame failed earlier — create+close the record now so it never stays 'playing'
    try{
      const grossPot=room.players.reduce((s,p)=>s+(p.hasPaid?((p.cardId?1:0)+(p.cardId2?1:0)):0),0)*room.stake;
      const gid=await db.saveGame(room.roomId,room.stakeId,room.stake,grossPot);
      await db.endGame(gid,winnerTids,winAmount,winners.length>1,room.calledNumbers);
    }catch(e){console.error('endGame fallback DB error:',e.message);}
  }

  const isSplit=winners&&winners.length>1;
  const msg=customMsg||(noWinner?'No winner this round':
    isSplit?`🤝 Split! ${winnerNames.join(' & ')} each win ${winAmount} ETB!`
           :`🏆 ${winnerNames[0]} wins ${winAmount} ETB!`);

  broadcast(room,{type:'gameOver',winners:winnerNames,winAmount,isSplit,message:msg,noWinner:!!noWinner});

  setTimeout(()=>{
    if(!rooms[room.roomId]) return;
    room.status='waiting'; room.calledNumbers=[]; room.availableNumbers=Array.from({length:75},(_,i)=>i+1);
    room.pot=0; room.takenCardIds=new Set(); room.claimedThisRound=[]; room.claimWindowOpen=false; room.dbGameId=null;
    room.players.forEach(p=>{p.cardId=null;p.cardId2=null;p.hasPaid=false;p.disqualified=false;});
    room.players.forEach(p=>{const cl=clients[p.playerId];send(p.ws,{type:'backToCardSelection',roomId:room.roomId,stakeId:room.stakeId,balance:cl?cl.balance:10});});
    broadcastCardPool(room);
    broadcastLobby();


},6000);
}
function leaveRoom(client){
  if(!client.roomId) return;
  const room=rooms[client.roomId];
  if(!room){client.roomId=null;return;}
  const p=room.players.find(p=>p.playerId===client.playerId);
  if(p){
    if(p.cardId) room.takenCardIds.delete(p.cardId);
    if(p.cardId2) room.takenCardIds.delete(p.cardId2);
    if(p.hasPaid&&(room.status==='waiting'||room.status==='countdown')){
      client.balance+=room.stake; saveBalance(client.telegramId,client.balance);
      send(client.ws,{type:'balanceUpdate',balance:client.balance});
    }
  }
  room.players=room.players.filter(p=>p.playerId!==client.playerId);
  client.roomId=null;
  if(room.players.length===0){if(room.callTimer)clearTimeout(room.callTimer);if(room.countdownTimer)clearInterval(room.countdownTimer);delete rooms[room.roomId];}
  else{broadcastCardPool(room);
 broadcast(room,{
  type:'playerLeft',
  playerCount:room.players.reduce(
    (sum,p)=>(p.cardId?1:0)+(p.cardId2?1:0)+sum,0
  )
});
  broadcastLobby();
}
}

// ─── WEBSOCKET ────────────────────────────────────────────────
wss.on('connection',(ws)=>{
  const playerId=uuidv4();
  const client={playerId,playerName:'',telegramId:null,balance:10,roomId:null,isAdmin:false,ws};
  clients[playerId]=client; ws._pid=playerId;

  const lobbyStakes=STAKES.map(s=>{const r=Object.values(rooms).find(r=>r.stakeId===s.id);
    return{stakeId:s.id,amount:s.amount,maxPlayers:s.maxPlayers,playerCount:r?r.players.length:0,status:r?r.status:'waiting',countdown:r&&r.status==='countdown'?r.countdownLeft:0};});
  send(ws,{type:'connected',playerId,balance:10,stakes:lobbyStakes});

  ws.on('message',async raw=>{
    try{
      const client=clients[ws._pid];
      if(!client) return;

      // ── Rate limiting: max 15 messages/sec per connection ──
      // Protects against spam/DoS and prevents one misbehaving client
      // (buggy or malicious) from hogging CPU when 400 people are connected.
      const now=Date.now();
      if(!client._rl||now-client._rl.windowStart>1000){
        client._rl={windowStart:now,count:0};
      }
      client._rl.count++;
      if(client._rl.count>15){
        return; // silently drop excess messages this second
      }

      const msg=JSON.parse(raw);

      switch(msg.type){
        case 'telegramAuth':{
          const tid=String(msg.telegramId);
          const user=await loadUser(tid);
          if(user){
            client.telegramId=tid; client.playerName=user.name; client.balance=user.balance; client.isAdmin=user.isAdmin||isAdminPhone(user.phone);
          send(ws,{type:'authSuccess',playerName:user.name,balance:user.balance,isRegistered:true,isAdmin:client.isAdmin,adminToken:client.isAdmin?ADMIN_PHONE:undefined});
          } else {
            client.telegramId=tid;
            send(ws,{type:'authSuccess',playerName:'',balance:10,isRegistered:false,isAdmin:false});
          }
          break;
        }
        case 'setName':{
          if(msg.name&&msg.name.trim()){client.playerName=msg.name.trim().substring(0,20);send(ws,{type:'nameSet',playerName:client.playerName});}
          break;
        }
      case 'reconnect':{
        const room=rooms[msg.roomId];

        if(!room||!['waiting','countdown','playing'].includes(room.status)){
          send(ws,{type:'reconnectFailed'});
          break;
        }

        // Try by playerId first, fall back to telegramId for page-reload reconnects
        let ep=room.players.find(p=>p.playerId===client.playerId);

        if(!ep&&msg.telegramId){
          const tid=String(msg.telegramId);
          ep=room.players.find(p=>String(p.telegramId)===tid);

          if(ep){
            // Re-link this new ws/client to the existing player slot
            const oldClient=Object.values(clients).find(
              c=>c.telegramId===tid&&c.playerId!==client.playerId
            );

            if(oldClient) delete clients[oldClient.playerId];

            ep.playerId=client.playerId;
            client.telegramId=tid;
          }
        }

        if(ep){
          ep.ws=ws;
          client.roomId=msg.roomId;

          const card=ep.cardId?getCard(ep.cardId):null;
          const card2=ep.cardId2?getCard(ep.cardId2):null;

          send(ws,{
            type:'reconnected',
            roomId:msg.roomId,
            stakeId:room.stakeId,
            cardId:ep.cardId,
            cardNumbers:card?card.numbers:[],
            cardId2:ep.cardId2||null,
            cardNumbers2:card2?card2.numbers:[],
            calledNumbers:room.calledNumbers,
            pot:room.pot,
            playerCount:room.players.length
          });

          send(ws,{
            type:'cardPoolUpdate',
            pool:getRoomCardPool(room).map(c=>({
              id:c.id,
              taken:room.takenCardIds.has(c.id),
              takenByMe:ep.cardId===c.id||ep.cardId2===c.id
            })),
            playerCount:room.players.reduce(
              (sum,p)=>(p.cardId?1:0)+(p.cardId2?1:0)+sum,0
            ),
            stakeAmount:room.stake,
            gameType:room.gameType,
            totalCards:getRoomCardPool(room).length
          });
        }else{
          send(ws,{type:'reconnectFailed'});
        }

        break;
      }
      case 'joinRoom':{
              const sc=STAKES.find(s=>s.id===msg.stakeId);
             if(!sc) return send(ws,{type:'error',message:'Invalid stake.'});
             leaveRoom(client);

          // ── If a game for this stake is already in progress, join as a spectator ──
          const liveRoom=Object.values(rooms).find(r=>r.stakeId===msg.stakeId&&r.status==='playing');
          if(liveRoom){
  client.roomId=liveRoom.roomId;

  send(ws,{
    type:'joinedRoom',
    roomId:liveRoom.roomId,
    stakeId:liveRoom.stakeId,
    balance:client.balance,
    status:liveRoom.status
  });

  send(ws,{
    type:'spectating',
    pot:prizePoolOf(liveRoom),
    playerCount:liveRoom.players.filter(p=>p.hasPaid).length,
    calledNumbers:liveRoom.calledNumbers
  });

  broadcastLobby();
  break;
}

          let reservedSuperBoards=[];

if(sc.type==='super' && db && client.telegramId){
  try{
    reservedSuperBoards=await db.getUserSuperBoards(client.telegramId);
  }catch(e){
    console.error('Super reservation load error:',e.message);
  }
}      
  
          const room=getOrCreateRoom(msg.stakeId);
          if(room.status!=='waiting'&&room.status!=='countdown') return send(ws,{type:'error',message:'Game already running.'});
          room.players.push({playerId:client.playerId,playerName:client.playerName,telegramId:client.telegramId,ws,cardId:null,cardId2:null,hasPaid:false,disqualified:false});
          client.roomId=room.roomId;
            console.log("🔥 SUPER RESERVED BOARDS:", reservedSuperBoards.map(r=>r.card_id));
          send(ws,{type:'joinedRoom',roomId:room.roomId,stakeId:room.stakeId,balance:client.balance,status:room.status,playerCount:room.players.reduce((sum,p)=>(p.cardId?sum+1:sum)+(p.cardId2?1:0),0),stakeAmount:room.stake,reservedSuperBoards:reservedSuperBoards.map(r=>r.card_id)});
         
  if(room.status==='countdown'){
  send(ws,{
    type:'countdown',
    seconds:room.countdownLeft
  });
}
         broadcastCardPool(room); broadcastLobby();
          const readyPlayers=room.players.filter(
  p=>p.cardId || p.cardId2
).length;

if(
  room.gameType !== 'super' &&
  readyPlayers >= 2 &&
  room.status === 'waiting'
){
  startCountdown(room);
}

}
break;

case 'selectCard':{
  if(!client.roomId) break;

  const room=rooms[client.roomId];

  if(!room || (room.status!=='waiting' && room.status!=='countdown')) break;

  const cardId=parseInt(msg.cardId);
  const slot=msg.slot===2 ? 2 : 1;

  const maxCards=room.gameType==='super'
    ? SUPER_TOTAL_CARDS
    : NORMAL_TOTAL_CARDS;

  if(cardId<1 || cardId>maxCards) break;

  const p=room.players.find(p=>p.playerId===client.playerId);
  if(!p) break;

  // ─────────────────────────────────────────────
  // SUPER BINGO
  // Payment + persistent reservation happen together.
  // ─────────────────────────────────────────────
  if(room.gameType==='super'){

    // If replacing the same slot, remove the old card first.
    const oldCardId=slot===1 ? p.cardId : p.cardId2;

    if(oldCardId){
      room.takenCardIds.delete(oldCardId);
    }

    // Never allow another currently-selected card.
    if(
      room.takenCardIds.has(cardId) &&
      cardId!==oldCardId
    ){
      if(oldCardId) room.takenCardIds.add(oldCardId);

      return send(ws,{
        type:'error',
        message:'Card already taken!'
      });
    }

    // Check persistent DB reservation before charging.
    if(db && client.telegramId){

      try{

        const existing=await db.getSuperBoardReservation(cardId);

        if(existing && String(existing.telegram_id)!==String(client.telegramId)){

          if(oldCardId) room.takenCardIds.add(oldCardId);

          return send(ws,{
            type:'error',
            message:'Card already taken!'
          });
        }

        // If this user already owns this exact card,
        // don't charge another 50 ETB.
        if(existing && String(existing.telegram_id)===String(client.telegramId)){

          if(slot===1){
            p.cardId=cardId;
          }else{
            p.cardId2=cardId;
          }

          room.takenCardIds.add(cardId);

          const card=getCard(cardId,'super');

          send(ws,{
            type:'cardSelected',
            cardId,
            cardNumbers:card.numbers,
            slot
          });

          broadcastCardDiff(room,[cardId]);

          break;
        }

        // Second card costs another 50 ETB.
        // First card also costs 50 ETB.
        const result=await db.reserveSuperBoard(
          client.telegramId,
          cardId
        );

        if(!result || !result.reservation){
          if(oldCardId) room.takenCardIds.add(oldCardId);

          return send(ws,{
            type:'error',
            message:'Could not reserve this card.'
          });
        }

        client.balance=result.balance;

        await saveBalance(
          client.telegramId,
          client.balance
        );

        if(db&&client.telegramId){
          try{
            await db.logTx(
              client.telegramId,
              'stake',
              -50,
              client.balance,
              room.roomId
            );
          }catch(e){
            console.error('Super stake log error:',e.message);
          }
        }

        if(slot===1){
          p.cardId=cardId;
        }else{
          p.cardId2=cardId;
        }

        room.takenCardIds.add(cardId);

        // Reservation succeeded, so this card is paid.
        p.hasPaid=true;

        send(ws,{
          type:'balanceUpdate',
          balance:client.balance
        });

        const card=getCard(cardId,'super');

        send(ws,{
          type:'cardSelected',
          cardId,
          cardNumbers:card.numbers,
          slot
        });

        broadcastCardDiff(
          room,
          oldCardId
            ? [oldCardId,cardId]
            : [cardId]
        );

      }catch(e){

        if(oldCardId){
          room.takenCardIds.add(oldCardId);
        }

        console.error(
          'Super card reservation error:',
          e.message
        );

        return send(ws,{
          type:'error',
          message:e.message || 'Unable to reserve card.'
        });
      }

    }else{

      return send(ws,{
        type:'error',
        message:'Database unavailable. Super Bingo card selection is temporarily unavailable.'
      });
    }

    break;
  }

  // ─────────────────────────────────────────────
  // NORMAL BINGO
  // Existing payment logic remains unchanged.
  // ─────────────────────────────────────────────

  if(room.takenCardIds.has(cardId)){
    return send(ws,{
      type:'error',
      message:'Card already taken!'
    });
  }

  const changedIds=new Set([cardId]);

  if(slot===1){

    if(p.cardId){
      room.takenCardIds.delete(p.cardId);
      changedIds.add(p.cardId);
    }

    if(client.balance<room.stake){
      return send(ws,{
        type:'error',
        message:`Need ${room.stake} ETB. Please deposit.`
      });
    }

    if(!p.hasPaid){
      client.balance-=room.stake;
      p.hasPaid=true;

      await saveBalance(
        client.telegramId,
        client.balance
      );

      if(db&&client.telegramId){
        try{
          await db.logTx(
            client.telegramId,
            'stake',
            -room.stake,
            client.balance,
            room.roomId
          );
        }catch(e){}
      }

      send(ws,{
        type:'balanceUpdate',
        balance:client.balance
      });
    }

    p.cardId=cardId;
    room.takenCardIds.add(cardId);

    const card=getCard(cardId);

    send(ws,{
      type:'cardSelected',
      cardId,
      cardNumbers:card.numbers,
      slot:1
    });

  }else{

    if(p.cardId2){
      room.takenCardIds.delete(p.cardId2);
      changedIds.add(p.cardId2);
    }

    if(client.balance<room.stake){
      return send(ws,{
        type:'error',
        message:`Need ${room.stake} ETB more for second card.`
      });
    }

    client.balance-=room.stake;

    await saveBalance(
      client.telegramId,
      client.balance
    );

    if(db&&client.telegramId){
      try{
        await db.logTx(
          client.telegramId,
          'stake',
          -room.stake,
          client.balance,
          room.roomId
        );
      }catch(e){}

    }

    send(ws,{
      type:'balanceUpdate',
      balance:client.balance
    });

    p.cardId2=cardId;
    room.takenCardIds.add(cardId);

    const card=getCard(cardId);

    send(ws,{
      type:'cardSelected',
      cardId,
      cardNumbers:card.numbers,
      slot:2
    });
  }

  broadcastCardDiff(
    room,
    Array.from(changedIds)
  );

  const readyCount=room.players.filter(
    p=>p.cardId || p.cardId2
  ).length;

  if(
    readyCount>=2 &&
    room.status==='waiting'
  ){
    startCountdown(room);
  }

  break;
}

                  case 'deselectCard':{
            if(!client.roomId) break;

            const room=rooms[client.roomId];

            if(!room||(room.status!=='waiting'&&room.status!=='countdown')) break;

            const p=room.players.find(p=>p.playerId===client.playerId);

            if(!p) break;

            // ── Super Bingo: release DB reservation ──
            const releaseSuper = async (cardId)=>{
              if(
                room.gameType==='super' &&
                db &&
                client.telegramId &&
                cardId
              ){
                try{
                  await db.releaseSuperBoard(
                    client.telegramId,
                    cardId
                  );
                }catch(e){
                  console.error(
                    'Super board release error:',
                    e.message
                  );
                }
              }
            };

            // ── Remove Card 2 ──
            if(msg.slot===2 && p.cardId2){

              const releasedId=p.cardId2;

              await releaseSuper(releasedId);

              room.takenCardIds.delete(releasedId);
              p.cardId2=null;

              // Refund second card stake
              client.balance+=room.stake;

              await saveBalance(
                client.telegramId,
                client.balance
              );

              if(db&&client.telegramId){
                try{
                  await db.logTx(
                    client.telegramId,
                    'stake_refund',
                    room.stake,
                    client.balance,
                    room.roomId
                  );
                }catch(e){}
              }

              send(ws,{
                type:'balanceUpdate',
                balance:client.balance
              });

              broadcastCardDiff(
                room,
                [releasedId]
              );

              break;

            // ── Remove Card 1 ──
            }else if(msg.slot===1 && p.cardId){

              const releasedIds=[p.cardId];

              await releaseSuper(p.cardId);

              room.takenCardIds.delete(p.cardId);
              p.cardId=null;

              // If Card 2 exists, release it too
              if(p.cardId2){

                releasedIds.push(p.cardId2);

                await releaseSuper(p.cardId2);

                room.takenCardIds.delete(p.cardId2);
                p.cardId2=null;

                client.balance+=room.stake;

                await saveBalance(
                  client.telegramId,
                  client.balance
                );

                if(db&&client.telegramId){
                  try{
                    await db.logTx(
                      client.telegramId,
                      'stake_refund',
                      room.stake,
                      client.balance,
                      room.roomId
                    );
                  }catch(e){}
                }

                send(ws,{
                  type:'balanceUpdate',
                  balance:client.balance
                });
              }

              // Refund Card 1 stake
              client.balance+=room.stake;
              p.hasPaid=false;

              await saveBalance(
                client.telegramId,
                client.balance
              );

              if(db&&client.telegramId){
                try{
                  await db.logTx(
                    client.telegramId,
                    'stake_refund',
                    room.stake,
                    client.balance,
                    room.roomId
                  );
                }catch(e){}
              }

              send(ws,{
                type:'balanceUpdate',
                balance:client.balance
              });

              broadcastCardDiff(
                room,
                releasedIds
              );

              break;
            }

            break;
          }
        case 'claimBingo':{
          if(!client.roomId) return;
          const room=rooms[client.roomId];
          if(!room||room.status!=='playing') return;
          const p=room.players.find(p=>p.playerId===client.playerId);
          if(!p||p.disqualified||(!p.cardId&&!p.cardId2)) return;
          if(!room.claimWindowOpen) return send(ws,{type:'claimTooLate',message:'Too late!'});
          if(!room.claimedThisRound.find(c=>c.playerId===client.playerId))
            room.claimedThisRound.push({
              playerId:client.playerId,
              markedIndices:msg.markedIndices||[],
              cardId2:msg.cardId2||null,
              markedIndices2:msg.markedIndices2||[]
            });
          if(room.callTimer) clearTimeout(room.callTimer);
          if(room.claimEvalTimer) clearTimeout(room.claimEvalTimer);
          room.claimEvalTimer=setTimeout(()=>evaluateClaims(room), CLAIM_COLLECT_MS);
          break;
        }
        case 'leaveRoom':
          leaveRoom(client); send(ws,{type:'leftRoom',balance:client.balance}); break;

        // ── Deposit request ──
        case 'depositRequest':{
          const{amount,txRef}=msg;
          if(!amount||amount<50) return send(ws,{type:'error',message:'Minimum deposit is 50 ETB.'});
          if(!txRef||!txRef.trim()) return send(ws,{type:'error',message:'Transaction reference required.'});
          if(!client.telegramId) return send(ws,{type:'error',message:'Please register first via the Telegram bot (/start).'});
          if(db){
            try{
              const id=await db.createDeposit(client.telegramId,amount,txRef.trim());
              if(!id) return send(ws,{type:'error',message:'Account not found in database. Please send /start to the bot again.'});
              send(ws,{type:'depositSubmitted',message:'Deposit request submitted! Waiting for admin approval.'});
            }catch(e){console.error('Deposit error:',e.message); send(ws,{type:'error',message:'Deposit failed: '+e.message});}
          } else {
            // Memory mode: auto-approve
            client.balance+=amount;
            send(ws,{type:'balanceUpdate',balance:client.balance});
            send(ws,{type:'depositSubmitted',message:'Deposit approved (demo mode).'});
          }
          break;
        }

        // ── Withdrawal request ──
        case 'withdrawalRequest':{
          const{amount}=msg;
          if(!amount||amount<100) return send(ws,{type:'error',message:'Minimum withdrawal is 100 ETB.'});
          if(client.balance<amount) return send(ws,{type:'error',message:'Insufficient balance.'});
          if(!client.telegramId) return send(ws,{type:'error',message:'Please register first.'});
          if(db){
            try{
              const result=await db.createWithdrawal(client.telegramId,amount);
              if(result.error) return send(ws,{type:'error',message:result.error});
              client.balance=result.newBalance;
              send(ws,{type:'balanceUpdate',balance:client.balance});
              send(ws,{type:'withdrawalSubmitted',message:'Withdrawal request submitted! Admin will process it soon.'});
            }catch(e){send(ws,{type:'error',message:'Failed to submit withdrawal.'});}
          } else {
            client.balance-=amount;
            send(ws,{type:'balanceUpdate',balance:client.balance});
            send(ws,{type:'withdrawalSubmitted',message:'Withdrawal submitted (demo mode).'});
          }
          break;
        }
      }
    }catch(err){console.error('WS:',err);}
  });

  ws.on('close',()=>{
    const c=clients[ws._pid];
    if(!c) return;

    if(c.roomId){
      const room=rooms[c.roomId];

      if(room){
        const p=room.players.find(p=>p.playerId===c.playerId);

        if(p){
          // Keep the player's selected cards when the Mini App is closed.
          // The reconnect handler can restore this player by Telegram ID.
          p.ws=null;
          p.disconnectedAt=Date.now();
        }

        // Do NOT call leaveRoom() here.
        // This keeps cardId/cardId2 and takenCardIds intact.
        broadcastCardPool(room);
        broadcastLobby();
      }
    }

    delete clients[ws._pid];
  });
  ws.on('error',()=>{});
});

// ─── ADMIN REST API ───────────────────────────────────────────
// Admin auth — accepts phone number OR telegram ID of the admin
function adminAuth(req,res,next){
  const tok=String(req.headers['x-admin-token']||req.query.token||'');
  if(isAdminPhone(tok)) return next();
  // Frontend sends telegramId as token — check if that user isAdmin
  const cl=Object.values(clients).find(c=>c.telegramId===tok);
  if(cl&&cl.isAdmin) return next();
  res.status(403).json({error:'Forbidden'});
}
app.get('/api/admin/admins',adminAuth,async(req,res)=>{
  if(!db)return res.json([]);
  res.json(await db.q('SELECT telegram_id,name,phone FROM users WHERE is_admin=true ORDER BY name'));
});
app.post('/api/admin/admins',adminAuth,async(req,res)=>{
  if(!db)return res.json({ok:true});
  const phone=String(req.body.phone||'').trim().replace(/^\+/,'');
  if(!phone)return res.status(400).json({error:'phone required'});
  const r=await db.q('UPDATE users SET is_admin=true WHERE phone=$1 RETURNING telegram_id,name,phone',[phone]);
  if(!r.length)return res.status(404).json({error:'User not found'});
  const cl=Object.values(clients).find(c=>c.telegramId===String(r[0].telegram_id));
  if(cl)cl.isAdmin=true;
  res.json({ok:true,user:r[0]});
});
app.delete('/api/admin/admins/:phone',adminAuth,async(req,res)=>{
  if(!db)return res.json({ok:true});
  const phone=decodeURIComponent(req.params.phone).replace(/^\+/,'');
  if(phone===ADMIN_PHONE)return res.status(403).json({error:'Cannot remove root admin'});
  await db.q('UPDATE users SET is_admin=false WHERE phone=$1',[phone]);
  const cl=Object.values(clients).find(c=>{const u=userCache[c.telegramId];return u&&u.phone===phone;});
  if(cl)cl.isAdmin=false;
  res.json({ok:true});
});

app.get('/api/admin/deposits', adminAuth, async(req,res)=>{
  if(!db) return res.json([]);
  res.json(await db.getDeposits(req.query.status||'pending'));
});
app.post('/api/admin/deposits/:id/approve', adminAuth, async(req,res)=>{
  if(!db) return res.json({ok:true});
  const result=await db.approveDeposit(parseInt(req.params.id));
  if(result){
    // Push balance update to connected user
    const cl=Object.values(clients).find(c=>c.telegramId===String(result.telegramId));
    if(cl){cl.balance=result.newBalance;send(cl.ws,{type:'balanceUpdate',balance:result.newBalance});send(cl.ws,{type:'notification',message:`✅ Deposit of ${result.amount} ETB approved!`});}
  }
  res.json({ok:true,result});
});
app.post('/api/admin/deposits/:id/reject', adminAuth, async(req,res)=>{
  if(!db) return res.json({ok:true});
  await db.rejectDeposit(parseInt(req.params.id));
  res.json({ok:true});
});

app.get('/api/admin/withdrawals', adminAuth, async(req,res)=>{
  if(!db) return res.json([]);
  res.json(await db.getWithdrawals(req.query.status||'pending'));
});
app.post('/api/admin/withdrawals/:id/approve', adminAuth, async(req,res)=>{
  if(!db) return res.json({ok:true});
  const result=await db.approveWithdrawal(parseInt(req.params.id));
  if(result){
    const cl=Object.values(clients).find(c=>c.telegramId===String(result.telegramId));
    if(cl) send(cl.ws,{type:'notification',message:`✅ Withdrawal of ${result.amount} ETB approved!`});
  }
  res.json({ok:true,result});
});
app.post('/api/admin/withdrawals/:id/reject', adminAuth, async(req,res)=>{
  if(!db) return res.json({ok:true});
  const result=await db.rejectWithdrawal(parseInt(req.params.id));
  if(result){
    const cl=Object.values(clients).find(c=>c.telegramId===String(result.telegramId));
    if(cl){cl.balance=result.newBalance;send(cl.ws,{type:'balanceUpdate',balance:result.newBalance});send(cl.ws,{type:'notification',message:`❌ Withdrawal rejected. ${result.newBalance} ETB refunded.`});}
  }
  res.json({ok:true,result});
});

app.get('/api/admin/search', adminAuth, async(req,res)=>{
  if(!db) return res.json([]);
  res.json(await db.searchByPhone(req.query.phone||''));
});

app.get('/api/admin/analytics', adminAuth, async(req,res)=>{
  if(!db) return res.json({error:'No database'});
  const { from, to } = req.query;
  const dateFrom = from ? new Date(from).toISOString() : new Date(Date.now()-30*86400000).toISOString();
  const dateTo   = to   ? new Date(new Date(to).setHours(23,59,59,999)).toISOString() : new Date().toISOString();
  try {
    const games = await db.q(
      `SELECT COUNT(*)::int as total_games,
              COALESCE(SUM(pot),0)::numeric as total_pot,
              COALESCE(SUM(win_amount),0)::numeric as total_paid_out,
              COUNT(CASE WHEN status='finished' THEN 1 END)::int as finished_games
       FROM games WHERE started_at BETWEEN $1 AND $2`, [dateFrom, dateTo]);

    const profit = await db.q(
      `SELECT COALESCE(SUM(pot - COALESCE(win_amount,0)),0)::numeric as house_profit
       FROM games WHERE status='finished' AND started_at BETWEEN $1 AND $2`, [dateFrom, dateTo]);

    const deposits = await db.q(
      `SELECT COUNT(*)::int as total,
              COUNT(CASE WHEN status='pending' THEN 1 END)::int as pending,
              COUNT(CASE WHEN status='approved' THEN 1 END)::int as approved,
              COUNT(CASE WHEN status='rejected' THEN 1 END)::int as rejected,
              COALESCE(SUM(CASE WHEN status='approved' THEN amount ELSE 0 END),0)::numeric as approved_amount,
              COALESCE(SUM(CASE WHEN status='pending' THEN amount ELSE 0 END),0)::numeric as pending_amount
       FROM deposit_requests WHERE created_at BETWEEN $1 AND $2`, [dateFrom, dateTo]);

    const withdrawals = await db.q(
      `SELECT COUNT(*)::int as total,
              COUNT(CASE WHEN status='pending' THEN 1 END)::int as pending,
              COUNT(CASE WHEN status='approved' THEN 1 END)::int as approved,
              COUNT(CASE WHEN status='rejected' THEN 1 END)::int as rejected,
              COALESCE(SUM(CASE WHEN status='approved' THEN amount ELSE 0 END),0)::numeric as approved_amount,
              COALESCE(SUM(CASE WHEN status='pending' THEN amount ELSE 0 END),0)::numeric as pending_amount
       FROM withdrawal_requests WHERE created_at BETWEEN $1 AND $2`, [dateFrom, dateTo]);

    const users = await db.q(
      `SELECT COUNT(*)::int as new_users FROM users WHERE created_at BETWEEN $1 AND $2`, [dateFrom, dateTo]);

    const totalUsers = await db.q(`SELECT COUNT(*)::int as count FROM users`);

    const dailyRevenue = await db.q(
      `SELECT DATE(started_at) as day,
              COUNT(*)::int as games,
              COALESCE(SUM(pot - COALESCE(win_amount,0)),0)::numeric as profit,
              COALESCE(SUM(pot),0)::numeric as pot
       FROM games WHERE status='finished' AND started_at BETWEEN $1 AND $2
       GROUP BY DATE(started_at) ORDER BY day ASC`, [dateFrom, dateTo]);

    const topWinners = await db.q(
      `SELECT u.name, u.phone,
              COUNT(CASE WHEN t.type='win' THEN 1 END)::int as wins,
              COALESCE(SUM(CASE WHEN t.type='win' THEN t.amount ELSE 0 END),0)::numeric as total_won
       FROM users u JOIN transactions t ON t.user_id=u.id
       WHERE t.created_at BETWEEN $1 AND $2 AND t.type='win'
       GROUP BY u.id, u.name, u.phone
       ORDER BY total_won DESC LIMIT 10`, [dateFrom, dateTo]);

    const recentTx = await db.q(
      `SELECT u.name, u.phone, t.type, t.amount, t.created_at
       FROM transactions t JOIN users u ON u.id=t.user_id
       WHERE t.created_at BETWEEN $1 AND $2
       ORDER BY t.created_at DESC LIMIT 20`, [dateFrom, dateTo]);

    const pendingDeposits = await db.q(
      `SELECT dr.id, dr.amount, dr.tx_ref, dr.created_at, u.name, u.phone
       FROM deposit_requests dr JOIN users u ON u.id=dr.user_id
       WHERE dr.status='pending' ORDER BY dr.created_at ASC LIMIT 20`);

    const pendingWithdrawals = await db.q(
      `SELECT wr.id, wr.amount, wr.created_at, u.name, u.phone
       FROM withdrawal_requests wr JOIN users u ON u.id=wr.user_id
       WHERE wr.status='pending' ORDER BY wr.created_at ASC LIMIT 20`);

    res.json({
      range: { from: dateFrom, to: dateTo },
      games: games[0],
      profit: profit[0],
      deposits: deposits[0],
      withdrawals: withdrawals[0],
      users: { ...users[0], total: totalUsers[0].count },
      dailyRevenue,
      topWinners,
      recentTx,
      pendingDeposits,
      pendingWithdrawals
    });
  } catch(e) {
    console.error('Analytics error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── Payment info (Telebirr account shown on deposit page) ──
app.get('/api/payment-info', (req,res)=>{
  res.json(PAYMENT_INFO);
});
app.get('/api/admin/payment-settings', adminAuth, (req,res)=>{
  res.json(PAYMENT_INFO);
});
app.post('/api/admin/payment-settings', adminAuth, async(req,res)=>{
  const { telebirrNumber, telebirrName } = req.body || {};
  if(telebirrNumber && String(telebirrNumber).trim()) PAYMENT_INFO.telebirrNumber = String(telebirrNumber).trim();
  if(telebirrName && String(telebirrName).trim())     PAYMENT_INFO.telebirrName   = String(telebirrName).trim();
  if(db){
    try{
      await db.setSetting('telebirr_number', PAYMENT_INFO.telebirrNumber);
      await db.setSetting('telebirr_name',   PAYMENT_INFO.telebirrName);
    }catch(e){ console.error('⚠️ Settings save:', e.message); }
  }
  res.json({ ok:true, ...PAYMENT_INFO });
});

app.get('/api/leaderboard', async(req,res)=>{
  if(!db) return res.json([]);
  res.json(await db.getLeaderboard());
});

app.get('/api/user/:tid', async(req,res)=>{
  const u=await loadUser(req.params.tid);
  if(!u) return res.status(404).json({error:'Not found'});
  res.json(u);
});

// ─── START ────────────────────────────────────────────────────
server.listen(PORT,()=>{
  console.log(`\n🎱 Kefay Bingo v5 on port ${PORT}\n`);
  startTelegramBot();
});

// ─── BOT ─────────────────────────────────────────────────────
// ─── BOT ─────────────────────────────────────────────────────
function startTelegramBot(){
  const TOKEN=process.env.BOT_TOKEN, GAME_URL=process.env.GAME_URL||'https://beteseb-bingo.onrender.com';
  if(!TOKEN){console.log('ℹ️ No BOT_TOKEN');return;}
  let Bot; try{Bot=require('node-telegram-bot-api');}catch(e){console.log('ℹ️ Bot lib missing');return;}
  const bot=new Bot(TOKEN,{polling:true}), pending={};

  const MAIN_MENU = {
    keyboard: [
      [{ text: '🎮 Play Now' }, { text: '📝 Register' }],
      [{ text: '💰 Deposit' }, { text: '💸 Withdraw' }],
      [{ text: '💰 Balance' }, { text: '🎁 Invite Friends' }],
      [{ text: '🎯 Game Patterns' }, { text: '📖 Instructions' }],
      [{ text: '🆘 24H Support 1' }, { text: '🆘 Support 2' }]
    ],
    resize_keyboard: true,
    persistent: true
  };

 async function showMainMenu(chatId, tid, firstName){
  const user = await loadUser(String(tid));

  if(user){
    bot.sendMessage(
      chatId,
      `🎱 *Kefay Bingo*

👤 User: *${user.name}*
💰 Balance: *${parseFloat(user.balance).toFixed(2)} ETB*

Choose Game 👇`,
      {
        parse_mode:'Markdown',
        reply_markup:{
          inline_keyboard:[
            [
              {
                text:'🎱 Normal Bingo',
                web_app:{
                  url:`${GAME_URL}?tid=${tid}&game=normal`
                }
              }
            ],
            [
              {
                text:'🔥 Super Bingo',
                web_app:{
                  url:`${GAME_URL}?tid=${tid}&game=super`
                }
              }
            ]
          ]
        }
      }
    );
  } else {
    pending[tid] = { step:'ask_phone', name: firstName || 'Player' };
    bot.sendMessage(chatId,
      `👋 Hi *${firstName || 'Player'}!*\nWelcome to *Kefay Bingo!* 🎱\n\nPlease share your phone number to register:`,
      { parse_mode:'Markdown', reply_markup:{ keyboard:[[{ text:'📱 Share Phone Number', request_contact:true }]], resize_keyboard:true, one_time_keyboard:true }}
    );
  }
}

  bot.onText(/\/start(?:\s+(.+))?/, async (msg, match) => {
    const tid = msg.from.id;
    const refCode = match && match[1];

    if (refCode && refCode.startsWith('ref_') && db) {
  const referralCode = refCode.substring(4);

  try {
    const referrer = await db.q(
      `SELECT id, telegram_id
       FROM users
       WHERE referral_code=$1`,
      [referralCode]
    );

    if (referrer.length > 0) {
      const referrerUser = referrer[0];

      if (String(referrerUser.telegram_id) !== String(tid)) {
        const existing = await db.getUser(String(tid));

        if (existing && !existing.referrer_id) {

          await db.q(
            `UPDATE users
             SET referrer_id=$1
             WHERE telegram_id=$2
             AND referrer_id IS NULL`,
            [referrerUser.id, String(tid)]
          );

          // 🎁 Give referrer 10 ETB immediately
          await db.q(
            `UPDATE users
             SET balance = balance + 10,
                 referral_bonus = referral_bonus + 10,
                 referral_count = referral_count + 1
             WHERE id=$1`,
            [referrerUser.id]
          );

          console.log(
            `🎁 Referral bonus: ${referrerUser.telegram_id} earned 10 ETB from ${tid}`
          );
        }
      }
    } else {
      console.log(`⚠️ Referral code not found: ${referralCode}`);
    }
  } catch (e) {
    console.error('Referral save error:', e.message);
  }
}

    await showMainMenu(
      msg.chat.id,
      tid,
      msg.from.first_name
    );
});
bot.onText(/\/play/,  msg => showMainMenu(msg.chat.id, msg.from.id, msg.from.first_name));

bot.onText(/🎮 Play Now/, async msg => {
  const tid = msg.from.id;
  const user = await loadUser(String(tid));

  if(!user){
    return bot.sendMessage(
      msg.chat.id,
      '⚠️ Please register first by pressing 📝 Register.',
      { reply_markup: MAIN_MENU }
    );
  }

  await bot.sendMessage(
    msg.chat.id,
    `🎱 *Choose Bingo Game*

💰 Balance: *${parseFloat(user.balance).toFixed(2)} ETB*`,
    {
      parse_mode:'Markdown',
      reply_markup:{
        inline_keyboard:[
          [
            {
              text:'🎱 Normal Bingo',
              web_app:{
                url:`${GAME_URL}?tid=${tid}&game=normal`
              }
            }
          ],
          [
            {
              text:'🔥 Super Bingo',
              web_app:{
                url:`${GAME_URL}?tid=${tid}&game=super`
              }
            }
          ]
        ]
      }
    }
  );
});

  bot.onText(/\/balance/, async msg => {
    const u = await loadUser(String(msg.from.id));
    bot.sendMessage(msg.chat.id,
      u ? `💰 Balance: *${parseFloat(u.balance).toFixed(2)} ETB*` : 'Use /start to register.',
      { reply_markup: MAIN_MENU }
    );
  });

  bot.on('message', async msg => {
    const tid = msg.from.id;
    const text = msg.text || '';

    // ── Handle registration flow ──
    const p = pending[tid];
    if(p && !text.startsWith('/')){
      if(p.step === 'ask_name'){
        p.name = text.trim().substring(0,30);
        p.step = 'ask_phone';
        bot.sendMessage(msg.chat.id,
          `Nice to meet you *${p.name}!* 👋\n\nPlease Share Your Phone Number:`,
          { parse_mode:'Markdown', reply_markup:{ keyboard:[[{ text:'📱 Share Phone Number', request_contact:true }]], resize_keyboard:true, one_time_keyboard:true }}
        );
      }
      return;
    }

    // ── Handle menu button presses ──
    const user = await loadUser(String(tid));

    if(text === '🎮 Play Now'){
  if(!user) {
    return bot.sendMessage(
      msg.chat.id,
      '⚠️ Please register first by pressing 📝 Register.',
      { reply_markup: MAIN_MENU }
    );
  }

  bot.sendMessage(
    msg.chat.id,
    `🎮 Choose Bingo Game\n\nSelect the game you want to play:`,
    {
      reply_markup:{
        inline_keyboard:[
          [
            {
              text:'🎱 Normal Bingo',
              web_app:{
                url:`${GAME_URL}?tid=${tid}&game=normal`
              }
            }
          ],
          [
            {
              text:'🔥 Super Bingo',
              web_app:{
                url:`${GAME_URL}?tid=${tid}&game=super`
              }
            }
          ]
        ]
      }
    }
  );
}

    else if(text === '📝 Register'){
      if(user) return bot.sendMessage(msg.chat.id, `✅ You are already registered as *${user.name}!*\n💰 Balance: *${parseFloat(user.balance).toFixed(2)} ETB*`, { reply_markup: MAIN_MENU });
      pending[tid] = { step:'ask_name' };
      bot.sendMessage(msg.chat.id, '📝 Let\'s get you registered!\n\nWhat should we call you?', { reply_markup: MAIN_MENU });
    }

    else if(text === '💰 Deposit'){
      if(!user) return bot.sendMessage(msg.chat.id, '⚠️ Please register first.', { reply_markup: MAIN_MENU });
      bot.sendMessage(msg.chat.id, `💰 Tap below to deposit:`, {
        reply_markup:{
          inline_keyboard:[[{ text:'💰 Deposit Now', web_app:{ url:`${GAME_URL}?tid=${tid}&page=deposit` }}]]
        }
      });
    }

    else if(text === '💸 Withdraw'){
      if(!user) return bot.sendMessage(msg.chat.id, '⚠️ Please register first.', { reply_markup: MAIN_MENU });
      bot.sendMessage(msg.chat.id, `💸 Tap below to withdraw:`, {
        reply_markup:{
          inline_keyboard:[[{ text:'💸 Withdraw Now', web_app:{ url:`${GAME_URL}?tid=${tid}&page=withdraw` }}]]
        }
      });
    }

    else if(text === '🔀 Transfer'){
      bot.sendMessage(msg.chat.id,
        `🔀 *Transfer*\n\nPlayer-to-player transfer is coming soon! Stay tuned 🚀`,
        { reply_markup: MAIN_MENU }
      );
    }

   else if(text === '🎁 Invite Friends'){
  const me = await bot.getMe();
  const user = await loadUser(String(tid));

  if(!user){
    return bot.sendMessage(
      msg.chat.id,
      '⚠️ Please register first.',
      { reply_markup: MAIN_MENU }
    );
  }

  const referralCode =
    user.referral_code || ('KF' + String(tid).slice(-8));

  const link =
    `https://t.me/${me.username}?start=ref_${referralCode}`;

  bot.sendMessage(
    msg.chat.id,
    `🎁 Invite Friends & Earn!\n\n🔗 Your referral link:\n${link}\n\n👥 Invite your friends and earn bonus ETB! 🎉`,
    { reply_markup: MAIN_MENU }
  );
} 


    else if(text === '🎯 Game Patterns'){
      bot.sendMessage(msg.chat.id,
        `🎯 *Winning Patterns*\n\n✅ Any complete *row* (horizontal)\n✅ Any complete *column* (vertical)\n✅ Either *diagonal*\n✅ *4 corners*\n\nThe FREE space in the center counts automatically!\n\nPress BINGO as soon as you complete a pattern! 🎉`,
        { reply_markup: MAIN_MENU }
      );
    }

    else if(text === '📖 Instructions'){
      bot.sendMessage(msg.chat.id,
        `📖 *How to Play Kefay Bingo*\n\n1️⃣ Deposit ETB into your wallet\n2️⃣ Choose a stake tier (10–100 ETB)\n3️⃣ Pick your lucky card (1–400)\n4️⃣ Numbers are called every 5 seconds\n5️⃣ Mark numbers on your card\n6️⃣ Complete a pattern and press *BINGO!* 🎉\n\n🏆 Winner gets *80%* of the total pot\n🏠 House takes *20%*\n⚠️ False BINGO = disqualification!`,
        { reply_markup: MAIN_MENU }
      );
    }

    else if(text === '🆘 24H Support 1'){
      bot.sendMessage(msg.chat.id,
        `🆘 *24H Support*\n\nContact us anytime:\n👤 @Kefay_support\n\nWe typically respond within a few minutes.`,
        { reply_markup: MAIN_MENU }
      );
    }

    else if(text === '🆘 Support 2'){
      bot.sendMessage(msg.chat.id,
        `🆘 *Support 2*\n\nAlternate support contact:\n👤 @Kefay_supoort2`,
        { reply_markup: MAIN_MENU }
      );
    }
  });

bot.on('contact', async msg => {
    const tid = msg.from.id, p = pending[tid];
    if(!p) return;
    const phone = (msg.contact.phone_number||'').replace(/^\+/,'');
    const name  = msg.contact.first_name || msg.from.first_name || 'Player';
    delete pending[tid];
    let balance = 0;
    if(db){
      try{
        const u = await db.createUser(String(tid), name, phone);
        balance = parseFloat(u.balance);
        userCache[String(tid)] = { name, phone, balance, isAdmin: isAdminPhone(phone) };
      } catch(e){ console.error('createUser error:', e.message); }
    } else {
      userCache[String(tid)] = { name, phone, balance:10, isAdmin: isAdminPhone(phone) };
    }
    bot.sendMessage(msg.chat.id,
      `✅ *Registered Successfully!*\n\n👤 Name: *${name}*\n📱 Phone: ${phone}\n💰 Balance: *${balance} ETB*\n\nDeposit ETB to start playing! 🎱`,
      { reply_markup: MAIN_MENU }
    );
  });

  console.log('🤖 Telegram bot started!');
}
