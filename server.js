require('dotenv').config();

/**
 * Kefay Bingo — Server v5
 * Changes:
 *  - 80% winner / 20% house cut
 *  - Disqualification only notifies the cheater (silent to others)
 *  - Admin page (phone 251993043478 → admin)
 *  - Deposit/withdrawal requests with approve/reject
 *  - Full DB integration
 */

const express   = require('express');
const http      = require('http');
const WebSocket = require('ws');
const { v4: uuidv4 } = require('uuid');
const path      = require('path');
const crypto    = require('crypto');

function verifyTelegramInitData(initData){
  try{
    if(!initData || !process.env.BOT_TOKEN) return null;

    const params = new URLSearchParams(initData);
    const hash = params.get('hash');

    if(!hash) return null;

    const dataCheckString = [...params.entries()]
      .filter(([key]) => key !== 'hash')
      .sort(([a],[b]) => a.localeCompare(b))
      .map(([key,value]) => `${key}=${value}`)
      .join('\n');

    const secretKey = crypto
      .createHmac('sha256', 'WebAppData')
      .update(process.env.BOT_TOKEN)
      .digest();

    const calculatedHash = crypto
      .createHmac('sha256', secretKey)
      .update(dataCheckString)
      .digest('hex');

    if(
      calculatedHash.length !== hash.length ||
      !crypto.timingSafeEqual(
        Buffer.from(calculatedHash),
        Buffer.from(hash)
      )
    ){
      return null;
    }

    const userRaw = params.get('user');
    if(!userRaw) return null;

    const user = JSON.parse(userRaw);

    if(!user.id) return null;

    return {
      telegramId: String(user.id),
      user
    };

  }catch(e){
    console.error('Telegram initData verification error:', e.message);
    return null;
  }
}

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
      max: 20,                      // cap concurrent DB connections
      idleTimeoutMillis: 30000,     // close idle connections after 30s
      connectionTimeoutMillis: 15000 // fail fast instead of hanging under load
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
       bonus_balance,
       win_balance,
       referral_code
     )
     VALUES($1,$2,$3,10,10,0,$4)
     ON CONFLICT(telegram_id)
     DO UPDATE SET last_seen=NOW(), name=$2
     RETURNING *`,
    [String(tid), name, phone, referralCode]
  );

  return r[0];
},
        async setBalance(tid, bal) {
          const u = await this.getUser(tid);
          if(!u) return;
          const bonus = parseFloat(u.bonus_balance) || 0;
          const win = Math.max(0, (parseFloat(bal) || 0) - bonus);
          await this.q('UPDATE users SET bonus_balance=$1, win_balance=$2, balance=$3 WHERE telegram_id=$4', [bonus, win, bonus + win, String(tid)]);
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
          const u = await this.q('SELECT telegram_id,bonus_balance,win_balance FROM users WHERE id=$1', [dep.user_id]);
          if (u[0]) {
            const newBonus = (parseFloat(u[0].bonus_balance) || 0) + parseFloat(dep.amount);
            const newBal = newBonus + (parseFloat(u[0].win_balance) || 0);
            await this.q('UPDATE users SET bonus_balance=$1, balance=$2 WHERE telegram_id=$3', [newBonus, newBal, String(u[0].telegram_id)]);
            await this.logTx(u[0].telegram_id, 'deposit', dep.amount, newBal, dep.tx_ref);
            return { telegramId: u[0].telegram_id, newBalance: newBal, bonusBalance: newBonus, winBalance: Number(u[0].win_balance) || 0, amount: dep.amount };
          }
        return null;
      },
      async rejectDeposit(id) {
        await this.q(`UPDATE deposit_requests SET status='rejected',approved_at=NOW() WHERE id=$1`, [id]);
      },

      // ── Withdrawals ──
      async createWithdrawal(tid, amount, withdrawPhone) {
          const u = await this.getUser(tid);
          if (!u || (parseFloat(u.win_balance) || 0) < amount) return { error: 'Insufficient Win Balance' };
          const newWin = (parseFloat(u.win_balance) || 0) - amount;
          const newBal = (parseFloat(u.bonus_balance) || 0) + newWin;
          await this.q('UPDATE users SET win_balance=$1, balance=$2 WHERE telegram_id=$3', [newWin, newBal, String(tid)]);
          await this.logTx(tid, 'withdrawal_pending', -amount, newBal, 'pending');
        const r = await this.q(
          `INSERT INTO withdrawal_requests(user_id,amount,withdraw_phone,status)
 SELECT id,$2,$3,'pending'
 FROM users
 WHERE telegram_id=$1
 RETURNING id`,
[String(tid), amount, withdrawPhone]
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
          `UPDATE withdrawal_requests SET status='approved',processed_at=NOW() WHERE id=$1 AND status='pending' RETURNING *`, [id]
        );
        if (!r[0]) return null;
        const wr = r[0];
          const u = await this.q('SELECT telegram_id,bonus_balance,win_balance FROM users WHERE id=$1', [wr.user_id]);
          if (u[0]) {
            const balanceAfter = (parseFloat(u[0].bonus_balance) || 0) + (parseFloat(u[0].win_balance) || 0);
            await this.logTx(u[0].telegram_id, 'withdrawal', -wr.amount, balanceAfter, 'approved');
            return { telegramId: u[0].telegram_id, amount: wr.amount, newBalance: balanceAfter, bonusBalance: Number(u[0].bonus_balance) || 0, winBalance: Number(u[0].win_balance) || 0 };
          }
          return { telegramId: undefined, amount: wr.amount };
      },
      async rejectWithdrawal(id) {
        // Refund the balance
        const r = await this.q(
          `UPDATE withdrawal_requests SET status='rejected',processed_at=NOW() WHERE id=$1 AND status='pending' RETURNING *`, [id]
        );
        if (!r[0]) return null;
        const wr = r[0];
          const u = await this.q('SELECT telegram_id,bonus_balance,win_balance FROM users WHERE id=$1', [wr.user_id]);
          if (u[0]) {
            const newWin = (parseFloat(u[0].win_balance) || 0) + parseFloat(wr.amount);
            const newBal = (parseFloat(u[0].bonus_balance) || 0) + newWin;
            await this.q('UPDATE users SET win_balance=$1, balance=$2 WHERE telegram_id=$3', [newWin, newBal, String(u[0].telegram_id)]);
            await this.logTx(u[0].telegram_id, 'withdrawal_refund', wr.amount, newBal, 'rejected');
            return { telegramId: u[0].telegram_id, newBalance: newBal, bonusBalance: Number(u[0].bonus_balance) || 0, winBalance: newWin };
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
  const r = await this.q(
    `INSERT INTO super_board_reservations
       (user_id, card_id, stake_amount, jackpot, status)
     SELECT id, $2, 50.00, 10000.00, 'locked'
     FROM users
     WHERE telegram_id=$1
     RETURNING *`,
    [String(tid), cardId]
  );
  return r[0] || null;
},
async getAllLockedSuperBoards() {
  return this.q(
    `SELECT sbr.*, u.telegram_id
     FROM super_board_reservations sbr
     JOIN users u ON u.id=sbr.user_id
     WHERE sbr.status='locked'
     ORDER BY sbr.card_id`
  );
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
const CALL_INTERVAL_MS = 5000;
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

function getNextSuperBingoTime(){
  const now = new Date();
  const next = new Date(now);

  next.setSeconds(0,0);

  for(let i=0;i<=7;i++){
    const day=(now.getDay()+i)%7;

    if(!SUPER_DAY.includes(day)) continue;

    next.setDate(now.getDate()+i);
    next.setHours(SUPER_HOUR,SUPER_MINUTE,0,0);

    if(next.getTime()>now.getTime()){
      return next;
    }
  }

  return null;
}

function getSuperCountdown(){
  const next=getNextSuperBingoTime();

  if(!next) return null;

  const diff=Math.max(
    0,
    next.getTime()-Date.now()
  );

  const totalSeconds=Math.floor(diff/1000);

  return {
    days:Math.floor(totalSeconds/86400),
    hours:Math.floor((totalSeconds%86400)/3600),
    minutes:Math.floor((totalSeconds%3600)/60),
    seconds:totalSeconds%60,
    timestamp:next.getTime()
  };
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
const WIN_PATTERNS = [
  {name:'Horizontal',      cells:[0,1,2,3,4]},
  {name:'Horizontal',      cells:[5,6,7,8,9]},
  {name:'Horizontal',      cells:[10,11,12,13,14]},
  {name:'Horizontal',      cells:[15,16,17,18,19]},
  {name:'Horizontal',      cells:[20,21,22,23,24]},

  {name:'Vertical',        cells:[0,5,10,15,20]},
  {name:'Vertical',        cells:[1,6,11,16,21]},
  {name:'Vertical',        cells:[2,7,12,17,22]},
  {name:'Vertical',        cells:[3,8,13,18,23]},
  {name:'Vertical',        cells:[4,9,14,19,24]},

  {name:'Diagonal',        cells:[0,6,12,18,24]},
  {name:'Diagonal',        cells:[4,8,12,16,20]},

  {name:'Four Corners',    cells:[0,4,20,24]}
];

function getWinningPatterns(nums, called, marked){
  const cs=new Set(called||[]);
  const ms=new Set(marked||[]);
  ms.add(12);

  const hit=i=>{
    return i===12 || (cs.has(nums[i]) && ms.has(i));
  };

  return WIN_PATTERNS
    .filter(p=>p.cells.every(i=>hit(i)))
    .map(p=>p.name)
    .filter((name,i,arr)=>arr.indexOf(name)===i);
}

function checkWin(nums, called, marked){
  return getWinningPatterns(nums, called, marked).length>0;
}

// ─── STATE ───────────────────────────────────────────────────
const clients={}, rooms={}, userCache={};

// ─── USER HELPERS ────────────────────────────────────────────
async function loadUser(tid) {
  if(db){try{const u=await db.getUser(tid);if(u){userCache[tid] = { name: u.name, phone: u.phone, balance: parseFloat(u.balance), bonusBalance: parseFloat(u.bonus_balance || 0), winBalance: parseFloat(u.win_balance || 0), isAdmin: u.is_admin === true };}}catch(e){}}
  return userCache[tid]||null;
}
async function saveWallet(tid, bonusBalance, winBalance) {
  const bonus = parseFloat(bonusBalance) || 0;
  const win = parseFloat(winBalance) || 0;
  const total = bonus + win;

  if(userCache[tid]){
    userCache[tid].bonusBalance = bonus;
    userCache[tid].winBalance = win;
    userCache[tid].balance = total;
  }

  if(db&&tid){
    try{
      await db.setWallet(tid, bonus, win);
    }catch(e){}
  }

  return total;
}


async function deductWallet(tid, amount) {
  const c = clients[Object.keys(clients).find(id => clients[id]?.telegramId === tid)];
  if(!c) return false;

  let bonus = parseFloat(c.bonusBalance) || 0;
  let win = parseFloat(c.winBalance) || 0;
  const stake = parseFloat(amount) || 0;

  if(bonus + win < stake) return false;

  const fromBonus = Math.min(bonus, stake);
  const fromWin = stake - fromBonus;

  bonus -= fromBonus;
  win -= fromWin;

  await saveWallet(tid, bonus, win);

  c.balance = bonus + win;
  c.bonusBalance = bonus;
  c.winBalance = win;

  return {
    fromBonus,
    fromWin,
    bonusBalance: bonus,
    winBalance: win,
    balance: c.balance
  };
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
   const superCountdown=getSuperCountdown();
   const payload=STAKES.map(s=>{const r=Object.values(rooms).find(r=>r.stakeId===s.id);
      if(r) console.log('👥 LOBBY DEBUG',s.id,r.players.map(p=>({id:p.playerId,paid:p.hasPaid,card1:p.cardId,card2:p.cardId2})));
      return{stakeId:s.id,amount:s.amount,maxPlayers:s.maxPlayers,
     playerCount:r?
     r.players.filter(p=>p.hasPaid&&(p.cardId||p.cardId2)).length:0,status:r?r.status:'waiting',countdown:r&&r.status==='countdown'?r.countdownLeft:0};});
    const payloadStr=JSON.stringify({
  type:'lobbyUpdate',
  stakes:payload,
  superCountdown
});
    Object.values(clients).forEach(c=>{if(!c.roomId&&c.ws&&c.ws.readyState===WebSocket.OPEN)c.ws.send(payloadStr);});
  },250);
}
function getRoomCardPool(room){
  return room.gameType === 'super'
    ? SUPER_CARD_POOL
    : NORMAL_CARD_POOL;
}

function broadcastCardPool(room){
  const pool = getRoomCardPool(room);
  console.log("🔥 CARD POOL DEBUG:", {
    stakeId: room.stakeId,
    gameType: room.gameType,
    poolLength: pool.length,
    takenCount: room.takenCardIds.size,
    players: room.players.length,
  });

  const base = pool.map(c => ({
    id: c.id,
    taken: room.takenCardIds.has(c.id)
  }));

  const cardCount = room.players.reduce(
    (sum,p) => sum + (p.cardId ? 1 : 0) + (p.cardId2 ? 1 : 0),
    0
  );

  room.players.forEach(async p => {

    let reservedSuperBoards=[];

    if(room.gameType==='super' && db && p.telegramId){
      try{
        const rows=await db.getUserSuperBoards(p.telegramId);
        reservedSuperBoards=rows.map(r=>Number(r.card_id));
      }catch(e){
        console.error('Super reservation pool error:',e.message);
      }
    }

    send(p.ws,{
      type:'cardPoolUpdate',

      pool:base.map(c => ({
        ...c,
        takenByMe:p.cardId===c.id || p.cardId2===c.id
      })),

      reservedSuperBoards,

      playerCount:cardCount,
      stakeAmount:room.stake,
      gameType:room.gameType,
      totalCards:pool.length,
    });
  });
}

// Lightweight update: tell everyone in the room only WHICH card(s) changed state,
// instead of re-sending the entire 400-card array on every single pick.
// This is the #1 fix for handling 400 concurrent players smoothly.
async function broadcastCardDiff(room, changedCardIds){
  const cardCount=room.players.reduce(
    (sum,p)=>(p.cardId?1:0)+(p.cardId2?1:0)+sum,0
  );

  const changes=changedCardIds.map(id=>({
    id,
    taken:room.takenCardIds.has(id)
  }));

  for(const p of room.players){
    let reservedSuperBoards=[];

    if(room.gameType==='super' && db && p.telegramId){
      try{
        const rows=await db.getUserSuperBoards(p.telegramId);
        reservedSuperBoards=rows.map(r=>Number(r.card_id));
      }catch(e){
        console.error('Super reservation diff error:',e.message);
      }
    }

    send(p.ws,{
      type:'cardPoolDiff',
      changes:changes.map(c=>({
        ...c,
        takenByMe:p.cardId===c.id||p.cardId2===c.id
      })),
      reservedSuperBoards,
      playerCount:cardCount,
      stakeAmount:room.stake,
      gameType:room.gameType,
      totalCards:room.gameType==='super'
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
      const card=p.cardId?getCard(p.cardId,room.gameType):null;
      const card2=p.cardId2?getCard(p.cardId2,room.gameType):null;
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

  // Prevent the scheduler from triggering the same Super Game more than once
  // during the scheduled minute.
  if(checkSuperSchedule._startedMinute === `${new Date().getFullYear()}-${new Date().getMonth()}-${new Date().getDate()}-${new Date().getHours()}-${new Date().getMinutes()}`){
    return;
  }

  // Super Bingo room must exist even if nobody joined before schedule time.
  let superRoom = Object.values(rooms).find(
    r => r.gameType === 'super' &&
         (r.status === 'waiting' || r.status === 'countdown')
  );

  if(!superRoom){
    superRoom = getOrCreateRoom('super50');
    console.log('🔥 SUPER BINGO scheduled room created');
  }

  if(superRoom.status !== 'waiting') return;

  const readyPlayers = superRoom.players.filter(
    p => p.cardId || p.cardId2
  );

  if(readyPlayers.length < 2) return;

  checkSuperSchedule._startedMinute = `${new Date().getFullYear()}-${new Date().getMonth()}-${new Date().getDate()}-${new Date().getHours()}-${new Date().getMinutes()}`;

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

  const winners=[];

  room.claimedThisRound.forEach(claim=>{
    const p=room.players.find(p=>p.playerId===claim.playerId);

    if(!p) return;

    // Only the card that actually pressed BINGO is checked.
    const slot=claim.slot===2 ? 2 : 1;

    const cardId=slot===2 ? p.cardId2 : p.cardId;

    if(!cardId) return;

    const card=getCard(cardId,room.gameType);

    if(!card) return;

    const win=checkWin(
      card.numbers,
      room.calledNumbers,
      claim.markedIndices||[]
    );

    if(win){

      p.winningCards=[{
        cardId,
        numbers:card.numbers,
        markedIndices:Array.from(
          new Set([
            ...(claim.markedIndices||[]),
            12
          ])
        )
      }];

      winners.push(p);

    }else{

      // Only the card that made the false BINGO is disqualified.
      // The player's other card continues playing.
      if(slot===1){
        p.card1Disqualified=true;
      }else{
        p.card2Disqualified=true;
      }

      send(p.ws,{
        type:'cardDisqualified',
        slot,
        cardId,
        message:`🚫 False BINGO on Card #${cardId}. This card is disqualified, but your other card can continue.`
      });
    }
  });

  room.claimedThisRound=[];
  room.claimWindowOpen=false;

  if(winners.length>0){
    endGame(room,winners,null,false);
  }else{
    scheduleNextCall(room);
  }
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
        cl.winBalance=(parseFloat(cl.winBalance)||0)+winAmount;
        winnerTids.push(cl.telegramId||'');
        await saveWallet(
          cl.telegramId,
          cl.bonusBalance,
          cl.winBalance
        );
        cl.balance=(parseFloat(cl.bonusBalance)||0)+(parseFloat(cl.winBalance)||0);
        if(db&&cl.telegramId){
          try{
            await db.logTx(
              cl.telegramId,
              'win',
              winAmount,
              cl.balance,
              room.roomId
            );
          }catch(e){}
        }
        send(w.ws,{
          type:'balanceUpdate',
          balance:cl.balance,
          bonusBalance:cl.bonusBalance,
          winBalance:cl.winBalance
        });
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

  const winnerCards = (winners||[]).map(w=>({
    playerName:w.playerName,
    cards:w.winningCards||[]
  }));

  broadcast(room,{
    type:'gameOver',
    winners:winnerNames,
    winAmount,
    isSplit,
    message:msg,
    noWinner:!!noWinner,
    winnerCards
  });

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
async function leaveRoom(client){
  if(!client.roomId) return;
  const room=rooms[client.roomId];
  if(!room){client.roomId=null;return;}
  const p=room.players.find(p=>p.playerId===client.playerId);
  if(p){

    // ── Release Super Bingo reservations when leaving ──
    if(
      room.gameType==='super' &&
      db &&
      client.telegramId &&
      (room.status==='waiting'||room.status==='countdown')
    ){
      for(const cardId of [p.cardId,p.cardId2]){
        if(!cardId) continue;

        try{
          await db.releaseSuperBoard(
            client.telegramId,
            cardId
          );
        }catch(e){
          console.error(
            'Super board leave release error:',
            e.message
          );
        }
      }
    }

    if(p.cardId) room.takenCardIds.delete(p.cardId);
    if(p.cardId2) room.takenCardIds.delete(p.cardId2);

    if(
  p.hasPaid &&
  (room.status==='waiting'||room.status==='countdown')
){
  const cardCount =
    (p.cardId ? 1 : 0) +
    (p.cardId2 ? 1 : 0);

  const refundAmount = room.stake * cardCount;

  if(refundAmount > 0){
    client.bonusBalance=(parseFloat(client.bonusBalance)||0)+(p.card1StakeFromBonus||0)+(p.card2StakeFromBonus||0); client.winBalance=(parseFloat(client.winBalance)||0)+(p.card1StakeFromWin||0)+(p.card2StakeFromWin||0); client.balance=client.bonusBalance+client.winBalance;

    await saveWallet(
      client.telegramId,
      client.bonusBalance,
      client.winBalance
    );

    if(db && client.telegramId){
      try{
        await db.logTx(
          client.telegramId,
          'stake_refund',
          refundAmount,
          client.balance,
          room.roomId
        );
      }catch(e){}
    }

      send(client.ws,{type:"balanceUpdate",balance:client.balance,bonusBalance:client.bonusBalance,winBalance:client.winBalance});
  }

  p.hasPaid=false;
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
    return{stakeId:s.id,amount:s.amount,maxPlayers:s.maxPlayers,playerCount:r?r.players.filter(p=>p.hasPaid&&(p.cardId||p.cardId2)).length:0,status:r?r.status:'waiting',countdown:r&&r.status==='countdown'?r.countdownLeft:0};});
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
      console.log('📨 WS MESSAGE:', msg.type, msg.stakeId || '');

      switch(msg.type){
        case 'telegramAuth':{
          const tid = msg.telegramId ? String(msg.telegramId) : null;

          if(!tid){
            send(ws,{
              type:'authError',
              message:'Telegram user ID not found.'
            });
            break;
          }

          const user=await loadUser(tid);

          if(user){
            client.telegramId=tid;
            client.playerName=user.name;
            client.balance=(user.bonusBalance||0)+(user.winBalance||0);
            client.bonusBalance=user.bonusBalance||0;
            client.winBalance=user.winBalance||0;
            client.isAdmin=user.isAdmin||isAdminPhone(user.phone);

            send(ws,{
              type:'authSuccess',
              playerName:user.name,
              balance:client.balance,
              bonusBalance:client.bonusBalance,
              winBalance:client.winBalance,
              isRegistered:true,
              isAdmin:client.isAdmin,
              adminToken:client.isAdmin?ADMIN_PHONE:undefined,
              stakes:lobbyStakes
            });
          } else {
            client.telegramId=tid;

            send(ws,{
              type:'authSuccess',
              playerName:'',
              balance:10,
              bonusBalance:10,
              winBalance:0,
              isRegistered:false,
              isAdmin:false,
              stakes:lobbyStakes
            });
          }

          break;
        }
        case 'setName':{
          if(msg.name&&msg.name.trim()){client.playerName=msg.name.trim().substring(0,20);send(ws,{type:'nameSet',playerName:client.playerName});}
          break;
        }
            case 'reconnect':{
        let room=rooms[msg.roomId];

        // Super Bingo rooms can survive through DB reservations
        // even when the player was offline.
        if(!room && msg.telegramId){
          room=getOrCreateRoom('super50');
        }

        if(!room||!['waiting','countdown','playing'].includes(room.status)){
          send(ws,{type:'reconnectFailed'});
          break;
        }

        const tid=msg.telegramId?String(msg.telegramId):null;

        // Try by playerId first, then telegramId.
        let ep=room.players.find(
          p=>p.playerId===client.playerId
        );

        if(!ep&&tid){
          ep=room.players.find(
            p=>String(p.telegramId)===tid
          );
        }

        // Restore Super Bingo cards from PostgreSQL when the
        // Mini App was closed and the in-memory player was lost.
        if(!ep&&room.gameType==='super'&&tid&&db){
          try{
            const rows=await db.getUserSuperBoards(tid);

            if(rows.length){
              ep={
                playerId:client.playerId,
                playerName:client.playerName,
                telegramId:tid,
                ws,
                cardId:Number(rows[0].card_id)||null,
                cardId2:rows[1]?Number(rows[1].card_id):null,
                hasPaid:true,
                disqualified:false
              };

              room.players.push(ep);

              rows.forEach(r=>{
                room.takenCardIds.add(Number(r.card_id));
              });

              console.log(
                '🔥 SUPER CARDS RESTORED:',
                tid,
                rows.map(r=>r.card_id)
              );
            }
          }catch(e){
            console.error(
              'Super card restore error:',
              e.message
            );
          }
        }

        if(ep){
          const oldClient=tid
            ? Object.values(clients).find(
                c=>c.telegramId===tid&&c.playerId!==client.playerId
              )
            : null;

          if(oldClient){
            delete clients[oldClient.playerId];
          }

          ep.playerId=client.playerId;
          ep.ws=ws;

          client.roomId=room.roomId;
          if(tid) client.telegramId=tid;

          const card=ep.cardId
            ?getCard(ep.cardId,room.gameType)
            :null;

          const card2=ep.cardId2
            ?getCard(ep.cardId2,room.gameType)
            :null;

          let reservedSuperBoards=[];

          if(room.gameType==='super'&&db&&tid){
            try{
              const rows=await db.getUserSuperBoards(tid);

              reservedSuperBoards=rows.map(
                r=>Number(r.card_id)
              );

              rows.forEach(r=>{
                room.takenCardIds.add(
                  Number(r.card_id)
                );
              });
            }catch(e){
              console.error(
                'Super reservation reconnect error:',
                e.message
              );
            }
          }

          send(ws,{
            type:'reconnected',
            roomId:room.roomId,
            stakeId:room.stakeId,
            status:room.status,
            cardId:ep.cardId,
            cardNumbers:card?card.numbers:[],
            cardId2:ep.cardId2||null,
            cardNumbers2:card2?card2.numbers:[],
            calledNumbers:room.calledNumbers,
            pot:room.pot,
            playerCount:room.players.filter(
              p=>p.hasPaid&&(p.cardId||p.cardId2)
            ).length,
            reservedSuperBoards
          });

          send(ws,{
            type:'cardPoolUpdate',
            pool:getRoomCardPool(room).map(c=>({
              id:c.id,
              taken:room.takenCardIds.has(c.id),
              takenByMe:
                ep.cardId===c.id||
                ep.cardId2===c.id
            })),
            reservedSuperBoards,
            playerCount:room.players.reduce(
              (sum,p)=>
                (p.cardId?1:0)+
                (p.cardId2?1:0)+sum,
              0
            ),
            stakeAmount:room.stake,
            gameType:room.gameType,
            totalCards:getRoomCardPool(room).length
          });

          if(room.status==='countdown'){
            send(ws,{
              type:'countdown',
              seconds:room.countdownLeft
            });
          }
        }else{
          send(ws,{type:'reconnectFailed'});
        }

        break;
      }
      case 'joinRoom':{
          console.log('🔥 JOIN ROOM RECEIVED:', msg.stakeId);
              console.log('🔥 JOIN ROOM RECEIVED:', msg.stakeId, msg);
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
          // ── Restore purchased Super Bingo cards ────────────────
let restoreCard1=null;
let restoreCard2=null;

if(sc.type==='super' && reservedSuperBoards.length){

  const validCards=reservedSuperBoards
    .map(r=>Number(r.card_id))
    .filter(id=>Number.isInteger(id) && id>=1 && id<=SUPER_TOTAL_CARDS);

  restoreCard1=validCards[0]||null;
  restoreCard2=validCards[1]||null;

  if(restoreCard1){
    room.takenCardIds.add(restoreCard1);
  }

  if(restoreCard2){
    room.takenCardIds.add(restoreCard2);
  }

  console.log('🔥 RESTORED SUPER CARDS:', {
    telegramId:client.telegramId,
    card1:restoreCard1,
    card2:restoreCard2
  });
}
         room.players.push({
  playerId:client.playerId,
  playerName:client.playerName,
  telegramId:client.telegramId,
  ws,
  cardId:restoreCard1,
  cardId2:restoreCard2,
  hasPaid:!!(restoreCard1||restoreCard2),
  disqualified:false
});
          client.roomId=room.roomId;
            console.log("🔥 SUPER RESERVED BOARDS:", reservedSuperBoards.map(r=>r.card_id));
          send(ws,{type:'joinedRoom',roomId:room.roomId,stakeId:room.stakeId,balance:client.balance,status:room.status,playerCount:room.players.reduce((sum,p)=>(p.cardId?sum+1:0)+(p.cardId2?1:0),0),stakeAmount:room.stake,reservedSuperBoards:reservedSuperBoards.map(r=>r.card_id)});
// Restore Super Bingo cards to the card-selection preview
if(room.gameType==='super' && (restoreCard1||restoreCard2)){

  if(restoreCard1){
    const card=getCard(restoreCard1,room.gameType);

    if(card){
      send(ws,{
        type:'cardSelected',
        cardId:restoreCard1,
        cardNumbers:card.numbers,
        slot:1
      });
    }
  }

  if(restoreCard2){
    const card=getCard(restoreCard2,room.gameType);

    if(card){
      send(ws,{
        type:'cardSelected',
        cardId:restoreCard2,
        cardNumbers:card.numbers,
        slot:2
      });
    }
  }
}
         
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

          if(!room||(room.status!=='waiting'&&room.status!=='countdown')) break;

          const cardId=parseInt(msg.cardId);
          const slot=msg.slot===2?2:1;

          const maxCards=room.gameType==='super'
            ? SUPER_TOTAL_CARDS
            : NORMAL_TOTAL_CARDS;

          if(cardId<1||cardId>maxCards) break;

          const p=room.players.find(p=>p.playerId===client.playerId);

          if(!p) break;

          const oldCardId=slot===1?p.cardId:p.cardId2;

          if(room.takenCardIds.has(cardId) && cardId!==oldCardId){
            return send(ws,{
              type:'error',
              message:'Card already taken!'
            });
          }

          const needsPayment=slot===1
            ? !p.hasPaid
            : !p.cardId2;

          if(needsPayment && client.balance<room.stake){
            return send(ws,{
              type:'error',
              message:slot===1
                ? `Need ${room.stake} ETB. Please deposit.`
                : `Need ${room.stake} ETB more for second card.`
            });
          }

          // ── Super Bingo reservation ───────────────────────
          if(room.gameType==='super' && db && client.telegramId){

            const existing=await db.getSuperBoardReservation(cardId);

            if(
              existing &&
              String(existing.telegram_id)!==String(client.telegramId)
            ){
              return send(ws,{
                type:'error',
                message:'Super Board already reserved!'
              });
            }

            if(!existing){
              const reserved=await db.reserveSuperBoard(
                client.telegramId,
                cardId
              );

              if(!reserved){
                return send(ws,{
                  type:'error',
                  message:'Unable to reserve this Super Board.'
                });
              }
            }
          }

          const changedIds=new Set([cardId]);

          // ── Release old card when replacing ────────────────
          if(oldCardId && oldCardId!==cardId){

            room.takenCardIds.delete(oldCardId);
            changedIds.add(oldCardId);

            if(
              room.gameType==='super' &&
              db &&
              client.telegramId
            ){
              try{
                await db.releaseSuperBoard(
                  client.telegramId,
                  oldCardId
                );
              }catch(e){
                console.error(
                  'Super board old-card release error:',
                  e.message
                );

                try{
                  await db.releaseSuperBoard(
                    client.telegramId,
                    cardId
                  );
                }catch(_){}

                return send(ws,{
                  type:'error',
                  message:'Unable to release previous Super Board.'
                });
              }
            }
          }

          // ── Slot 1 ─────────────────────────────────────────
          if(slot===1){

            if(!p.hasPaid){

              const deduction = await deductWallet(
                client.telegramId,
                room.stake
              );

              if(!deduction){
                return send(ws,{
                  type:'error',
                  message:`Need ${room.stake} ETB. Please deposit.`
                });
              }

              p.hasPaid=true;
              p.card1StakeFromBonus=deduction.fromBonus;
              p.card1StakeFromWin=deduction.fromWin;

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

                send(ws,{type:"balanceUpdate",balance:client.balance,bonusBalance:client.bonusBalance,winBalance:client.winBalance});
            }

            p.cardId=cardId;
            room.takenCardIds.add(cardId);

            const card=getCard(
              cardId,
              room.gameType
            );

            send(ws,{
              type:'cardSelected',
              cardId,
              cardNumbers:card.numbers,
              slot:1
            });

          // ── Slot 2 ─────────────────────────────────────────
          }else{

            if(!p.cardId2){

              const deduction = await deductWallet(
                client.telegramId,
                room.stake
              );

              if(!deduction){
                return send(ws,{
                  type:'error',
                  message:`Need ${room.stake} ETB more for second card.`
                });
              }

              p.card2StakeFromBonus=deduction.fromBonus;
              p.card2StakeFromWin=deduction.fromWin;

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

              send(ws,{type:"balanceUpdate",balance:client.balance,bonusBalance:client.bonusBalance,winBalance:client.winBalance});
            }

            p.cardId2=cardId;
            room.takenCardIds.add(cardId);

            const card=getCard(
              cardId,
              room.gameType
            );

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
            p=>p.cardId||p.cardId2
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

          // ── Remove Card 2 ONLY ──
          if(msg.slot===2 && p.cardId2){

            const releasedId=p.cardId2;

            await releaseSuper(releasedId);

            room.takenCardIds.delete(releasedId);
            p.cardId2=null;

            // Refund Card 2 stake to the same wallet sources
            const refundBonus=p.card2StakeFromBonus||0;
            const refundWin=p.card2StakeFromWin||0;

            client.bonusBalance=(parseFloat(client.bonusBalance)||0)+refundBonus;
            client.winBalance=(parseFloat(client.winBalance)||0)+refundWin;

            await saveWallet(
              client.telegramId,
              client.bonusBalance,
              client.winBalance
            );
              client.balance=client.bonusBalance+client.winBalance;

            p.card2StakeFromBonus=0;
            p.card2StakeFromWin=0;

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

              send(ws,{type:"balanceUpdate",balance:client.balance,bonusBalance:client.bonusBalance,winBalance:client.winBalance});

            broadcastCardDiff(
              room,
              [releasedId]
            );

            break;
          }

          // ── Remove Card 1 ONLY ──
          if(msg.slot===1 && p.cardId){

            const releasedId=p.cardId;

            await releaseSuper(releasedId);

            room.takenCardIds.delete(releasedId);
            p.cardId=null;

            // Refund Card 1 stake to the same wallet sources
            const refundBonus=p.card1StakeFromBonus||0;
            const refundWin=p.card1StakeFromWin||0;

            client.bonusBalance=(parseFloat(client.bonusBalance)||0)+refundBonus;
            client.winBalance=(parseFloat(client.winBalance)||0)+refundWin;

            await saveWallet(
              client.telegramId,
              client.bonusBalance,
              client.winBalance
            );
              client.balance=client.bonusBalance+client.winBalance;

            p.card1StakeFromBonus=0;
            p.card1StakeFromWin=0;
            p.hasPaid=false;

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

              send(ws,{type:"balanceUpdate",balance:client.balance,bonusBalance:client.bonusBalance,winBalance:client.winBalance});

            broadcastCardDiff(
              room,
              [releasedId]
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
          if(!p||(!p.cardId&&!p.cardId2)) return;

          if(!room.claimWindowOpen)
            return send(ws,{type:'claimTooLate',message:'Too late!'});

          const slot=msg.slot===2 ? 2 : 1;
          const cardId=slot===2 ? p.cardId2 : p.cardId;

          if(!cardId) return;

          if(slot===1 && p.card1Disqualified) return;
          if(slot===2 && p.card2Disqualified) return;

          if(!room.claimedThisRound.find(
            c=>c.playerId===client.playerId && c.slot===slot
          )){
            room.claimedThisRound.push({
              playerId:client.playerId,
              slot,
              cardId,
              markedIndices:msg.markedIndices||[]
            });
          }

          if(room.callTimer) clearTimeout(room.callTimer);
          if(room.claimEvalTimer) clearTimeout(room.claimEvalTimer);

          room.claimEvalTimer=setTimeout(
            ()=>evaluateClaims(room),
            CLAIM_COLLECT_MS
          );

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
          if (adminBot && process.env.ADMIN_TELEGRAM_ID) {
  try {
    const deposits = await db.getDeposits('pending');
    const d = deposits.find(x => String(x.id) === String(id));

    if (d) {
      await adminBot.sendMessage(
        process.env.ADMIN_TELEGRAM_ID,
        `🔔 *NEW DEPOSIT REQUEST*\n\n` +
        `👤 Name: *${d.name || 'Unknown'}*\n` +
        `📱 Phone: ${d.phone || 'N/A'}\n` +
        `💵 Amount: *${Number(d.amount).toFixed(2)} ETB*\n` +
        `🧾 Transaction Ref: \`${d.tx_ref}\`\n\n` +
        `🆔 Request ID: ${d.id}`,
        {
          parse_mode: 'Markdown',
          reply_markup: {
            inline_keyboard: [[
              { text: '✅ APPROVE', callback_data: `deposit_approve_${d.id}` },
              { text: '❌ REJECT', callback_data: `deposit_reject_${d.id}` }
            ]]
          }
        }
      );
    }
  } catch (e) {
    console.error('Admin deposit notification error:', e.message);
  }
}
             send(ws,{type:'depositSubmitted',message:'Deposit request submitted! Waiting for admin approval.'});
            }catch(e){console.error('Deposit error:',e.message); send(ws,{type:'error',message:'Deposit failed: '+e.message});}
          } else {
            // Memory mode: auto-approve
            client.bonusBalance=(parseFloat(client.bonusBalance)||0)+amount; client.balance=client.bonusBalance+(parseFloat(client.winBalance)||0);
              send(ws,{type:"balanceUpdate",balance:client.balance,bonusBalance:client.bonusBalance,winBalance:client.winBalance});
            send(ws,{type:'depositSubmitted',message:'Deposit approved (demo mode).'});
          }
          break;
        }

        // ── Withdrawal request ──
        case 'withdrawalRequest':{
          const{amount,withdrawPhone}=msg;
          if(!amount||amount<100) return send(ws,{type:'error',message:'Minimum withdrawal is 100 ETB.'});
          if((parseFloat(client.winBalance)||0)<amount) return send(ws,{type:'error',message:'Insufficient Win Balance.'});
          if(!client.telegramId) return send(ws,{type:'error',message:'Please register first.'});
          if(db){
            try{
          if(!withdrawPhone){
  return send(ws,{
    type:'error',
    message:'Please enter a withdrawal phone number.'
  });
}
              const result=await db.createWithdrawal(
  client.telegramId,
  amount,
  withdrawPhone
);
              if(result.error) return send(ws,{type:'error',message:result.error});
          if (adminBot && process.env.ADMIN_TELEGRAM_ID) {
  try {
    const withdrawals = await db.getWithdrawals('pending');
    const w = withdrawals.find(x => String(x.id) === String(result.id));

    if (w) {
      await adminBot.sendMessage(
        process.env.ADMIN_TELEGRAM_ID,
        `🔔 *NEW WITHDRAWAL REQUEST*\n\n` +
        `👤 Name: *${w.name || 'Unknown'}*\n` +
        `📱 Receive Money At: *${w.withdraw_phone || '—'}*\n` +
        `💵 Amount: *${Number(w.amount).toFixed(2)} ETB*\n\n` +
        `🆔 Request ID: ${w.id}`,
        {
          parse_mode: 'Markdown',
          reply_markup: {
            inline_keyboard: [[
              { text: '✅ APPROVE', callback_data: `withdraw_approve_${w.id}` },
              { text: '❌ REJECT', callback_data: `withdraw_reject_${w.id}` }
            ]]
          }
        }
      );
    }
  } catch (e) {
    console.error('Admin withdrawal notification error:', e.message);
  }
}
              client.bonusBalance=result.bonusBalance; client.winBalance=result.winBalance; client.balance=result.newBalance;
                send(ws,{type:"balanceUpdate",balance:client.balance,bonusBalance:client.bonusBalance,winBalance:client.winBalance});
              send(ws,{type:'withdrawalSubmitted',message:'Withdrawal request submitted! Admin will process it soon.'});
            }catch(e){send(ws,{type:'error',message:'Failed to submit withdrawal.'});}
          } else {
            client.winBalance=(parseFloat(client.winBalance)||0)-amount; client.balance=(parseFloat(client.bonusBalance)||0)+client.winBalance;
              send(ws,{type:"balanceUpdate",balance:client.balance,bonusBalance:client.bonusBalance,winBalance:client.winBalance});
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
      if(cl){cl.bonusBalance=result.bonusBalance;cl.winBalance=result.winBalance;cl.balance=result.newBalance;send(cl.ws,{type:"balanceUpdate",balance:result.newBalance,bonusBalance:result.bonusBalance,winBalance:result.winBalance});send(cl.ws,{type:"notification",message:`✅ Deposit of ${result.amount} ETB approved!`});}
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
      if(cl){cl.bonusBalance=result.bonusBalance;cl.winBalance=result.winBalance;cl.balance=result.newBalance;send(cl.ws,{type:"balanceUpdate",balance:result.newBalance,bonusBalance:result.bonusBalance,winBalance:result.winBalance});send(cl.ws,{type:"notification",message:`❌ Withdrawal rejected. ${result.newBalance} ETB refunded.`});}
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
let adminBot = null;

function startTelegramBot(){
  const TOKEN=process.env.BOT_TOKEN, GAME_URL=process.env.GAME_URL||'https://beteseb-bingo.onrender.com';
  if(!TOKEN){console.log('ℹ️ No BOT_TOKEN');return;}
  let Bot; try{Bot=require('node-telegram-bot-api');}catch(e){console.log('ℹ️ Bot lib missing');return;}
  const bot=new Bot(TOKEN,{polling:true});
adminBot = bot;
const ADMIN_TELEGRAM_ID = String(process.env.ADMIN_TELEGRAM_ID || '');

console.log(
  ADMIN_TELEGRAM_ID
    ? `👑 Admin Telegram notifications enabled: ${ADMIN_TELEGRAM_ID}`
    : '⚠️ ADMIN_TELEGRAM_ID is missing'
);
const pending = {};

  function MAIN_MENU(tid){
    const id = String(tid);

    return {
      keyboard: [
        [
          { text: 'NORMAL BINGO', web_app: { url: `${GAME_URL}?tid=${id}&game=normal` } },
          { text: 'SUPER BINGO', web_app: { url: `${GAME_URL}?tid=${id}&game=super` } }
        ],
        [
          { text: 'DEPOSIT', web_app: { url: `${GAME_URL}?tid=${id}&page=deposit` } },
          { text: 'WITHDRAW', web_app: { url: `${GAME_URL}?tid=${id}&page=withdraw` } }
        ],
        [
          { text: 'REGISTER' }
        ],
        [
          { text: 'INVITE FRIENDS' },
          { text: 'BALANCE' }
        ],
        [
          { text: '24H SUPPORT 1' },
          { text: 'SUPPORT 2' }
        ]
      ],
      resize_keyboard: true,
      persistent: true
    };
  }

 async function showMainMenu(chatId, tid, firstName){
  const user = await loadUser(String(tid));

  if(user){
    bot.sendMessage(
      chatId,
      `👋 Welcome back, *${user.name}*!\n\nUse the buttons below. 👇`,
      {
        parse_mode:'Markdown',
        reply_markup:MAIN_MENU(tid)
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

    // Direct registration request from Mini App
    if(refCode === 'register'){
      const existing = await loadUser(String(tid));

      if(existing){
        return bot.sendMessage(
          msg.chat.id,
          `✅ You are already registered as *${existing.name}!*
💰 Balance: *${parseFloat(existing.balance).toFixed(2)} ETB*`,
          { parse_mode:'Markdown', reply_markup:MAIN_MENU(tid) }
        );
      }

      pending[tid] = { step:'ask_name' };

      return bot.sendMessage(
        msg.chat.id,
        '📝 Let\'s get you registered!\n\nWhat should we call you?',
        {
          parse_mode:'Markdown',
          reply_markup:{
            remove_keyboard:true
          }
        }
      );
    }

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

           // 📊 Count referral only — no immediate bonus
await db.q(
  `UPDATE users
   SET referral_count = referral_count + 1
   WHERE id=$1`,
  [referrerUser.id]
);

console.log(
  `👥 Referral counted: ${referrerUser.telegram_id} invited ${tid}`
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
      { reply_markup: MAIN_MENU(tid) }
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
              text:'NORMAL BINGO',
              web_app:{
                url:`${GAME_URL}?tid=${tid}&game=normal`
              }
            }
          ],
          [
            {
              text:'SUPER BINGO',
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
      { reply_markup: MAIN_MENU(tid) }
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

    if(text === 'REGISTER'){
      if(user) return bot.sendMessage(msg.chat.id, `✅ You are already registered as *${user.name}!*\n💰 Balance: *${parseFloat(user.balance).toFixed(2)} ETB*`, { reply_markup: MAIN_MENU(tid) });
      pending[tid] = { step:'ask_name' };
      bot.sendMessage(msg.chat.id, '📝 Let\'s get you registered!\n\nWhat should we call you?', { reply_markup: MAIN_MENU(tid) });
    }

    else if(text === '🔀 Transfer'){
      bot.sendMessage(msg.chat.id,
        `🔀 *Transfer*\n\nPlayer-to-player transfer is coming soon! Stay tuned 🚀`,
        { reply_markup: MAIN_MENU(tid) }
      );
    }

   else if(text === 'INVITE FRIENDS'){
  const me = await bot.getMe();
  const user = await loadUser(String(tid));

  if(!user){
    return bot.sendMessage(
      msg.chat.id,
      '⚠️ Please register first.',
      { reply_markup: MAIN_MENU(tid) }
    );
  }

  const referralCode =
    user.referral_code || ('KF' + String(tid).slice(-8));

  const link =
    `https://t.me/${me.username}?start=ref_${referralCode}`;

  bot.sendMessage(
    msg.chat.id,
    `🎁 Invite Friends & Earn!\n\n🔗 Your referral link:\n${link}\n\n👥 Invite your friends and earn bonus ETB! 🎉`,
    { reply_markup: MAIN_MENU(tid) }
  );
} 


    else if(text === '🎯 Game Patterns'){
      bot.sendMessage(msg.chat.id,
        `🎯 *Winning Patterns*\n\n✅ Any complete *row* (horizontal)\n✅ Any complete *column* (vertical)\n✅ Either *diagonal*\n✅ *4 corners*\n\nThe FREE space in the center counts automatically!\n\nPress BINGO as soon as you complete a pattern! 🎉`,
        { reply_markup: MAIN_MENU(tid) }
      );
    }

    else if(text === '📖 Instructions'){
      bot.sendMessage(msg.chat.id,
        `📖 *How to Play Kefay Bingo*\n\n1️⃣ Deposit ETB into your wallet\n2️⃣ Choose a stake tier (10–100 ETB)\n3️⃣ Pick your lucky card (1–400)\n4️⃣ Numbers are called every 5 seconds\n5️⃣ Mark numbers on your card\n6️⃣ Complete a pattern and press *BINGO!* 🎉\n\n🏆 Winner gets *80%* of the total pot\n🏠 House takes *20%*\n⚠️ False BINGO = disqualification!`,
        { reply_markup: MAIN_MENU(tid) }
      );
    }

    else if(text === '24H SUPPORT 1'){
      bot.sendMessage(msg.chat.id,
        `🆘 *24H Support*\n\nContact us anytime:\n👤 @Kefay_support\n\nWe typically respond within a few minutes.`,
        { reply_markup: MAIN_MENU(tid) }
      );
    }

    else if(text === 'SUPPORT 2'){
      bot.sendMessage(msg.chat.id,
        `🆘 *Support 2*\n\nAlternate support contact:\n👤 @Kefay_supoort2`,
        { reply_markup: MAIN_MENU(tid) }
      );
    }
  });

// ── Admin Telegram approve/reject buttons ──
  bot.on('callback_query', async (query) => {
    try {
      const adminId = String(query.from.id);

      // Only the configured admin can use these buttons
      if (!ADMIN_TELEGRAM_ID || adminId !== ADMIN_TELEGRAM_ID) {
        return bot.answerCallbackQuery(query.id, {
          text: '⛔ Unauthorized',
          show_alert: true
        });
      }

      const data = String(query.data || '');

      // ── Deposit ──
      if (data.startsWith('deposit_approve_')) {
        const id = parseInt(data.replace('deposit_approve_', ''), 10);

        if (!db || !id) {
          return bot.answerCallbackQuery(query.id, {
            text: '❌ Invalid deposit request',
            show_alert: true
          });
        }

        const result = await db.approveDeposit(id);

        if (!result) {
          return bot.answerCallbackQuery(query.id, {
            text: '⚠️ Already processed or not found',
            show_alert: true
          });
        }

        await bot.answerCallbackQuery(query.id, {
          text: '✅ Deposit approved'
        });

        await bot.editMessageReplyMarkup(
          {
            chat_id: query.message.chat.id,
            message_id: query.message.message_id
          }
        );
        await bot.sendMessage(
          ADMIN_TELEGRAM_ID,
          `✅ *Deposit Approved*\n\n` +
          `👤 Telegram ID: ${result.telegramId}\n` +
          `💰 Amount: ${result.amount} ETB\n` +
          `💳 New Balance: ${result.newBalance} ETB`,
          { parse_mode: 'Markdown' }
        );

        return;
      }

      if (data.startsWith('deposit_reject_')) {
        const id = parseInt(data.replace('deposit_reject_', ''), 10);

        if (!db || !id) {
          return bot.answerCallbackQuery(query.id, {
            text: '❌ Invalid deposit request',
            show_alert: true
          });
        }

        const result = await db.rejectDeposit(id);

        await bot.answerCallbackQuery(query.id, {
          text: '❌ Deposit rejected'
        });

        await bot.editMessageReplyMarkup(
          { inline_keyboard: [] },
          {
            chat_id: query.message.chat.id,
            message_id: query.message.message_id
          }
        );

        await bot.sendMessage(
          ADMIN_TELEGRAM_ID,
          `❌ *Deposit Rejected*\n\n🆔 Request ID: ${id}`,
          { parse_mode: 'Markdown' }
        );

        return;
      }

      // ── Withdrawal ──
      if (data.startsWith('withdraw_approve_')) {
        const id = parseInt(data.replace('withdraw_approve_', ''), 10);

        if (!db || !id) {
          return bot.answerCallbackQuery(query.id, {
            text: '❌ Invalid withdrawal request',
            show_alert: true
          });
        }

        const result = await db.approveWithdrawal(id);

        if (!result) {
          return bot.answerCallbackQuery(query.id, {
            text: '⚠️ Already processed or not found',
            show_alert: true
          });
        }

        await bot.answerCallbackQuery(query.id, {
          text: '✅ Withdrawal approved'
        });

        await bot.editMessageReplyMarkup(
          { inline_keyboard: [] },
          {
            chat_id: query.message.chat.id,
            message_id: query.message.message_id
          }
        );

        await bot.sendMessage(
          ADMIN_TELEGRAM_ID,
          `✅ *Withdrawal Approved*\n\n` +
          `👤 Telegram ID: ${result.telegramId}\n` +
          `💸 Amount: ${result.amount} ETB`,
          { parse_mode: 'Markdown' }
        );

        return;
      }

      if (data.startsWith('withdraw_reject_')) {
        const id = parseInt(data.replace('withdraw_reject_', ''), 10);

        if (!db || !id) {
          return bot.answerCallbackQuery(query.id, {
            text: '❌ Invalid withdrawal request',
            show_alert: true
          });
        }

        const result = await db.rejectWithdrawal(id);

        if (!result) {
          return bot.answerCallbackQuery(query.id, {
            text: '⚠️ Already processed or not found',
            show_alert: true
          });
        }

        await bot.answerCallbackQuery(query.id, {
          text: '❌ Withdrawal rejected and refunded'
        });

        await bot.editMessageReplyMarkup(
          { inline_keyboard: [] },
          {
            chat_id: query.message.chat.id,
            message_id: query.message.message_id
          }
        );

        await bot.sendMessage(
          ADMIN_TELEGRAM_ID,
          `❌ *Withdrawal Rejected*\n\n` +
          `👤 Telegram ID: ${result.telegramId}\n` +
          `💰 Refunded Balance: ${result.newBalance} ETB`,
          { parse_mode: 'Markdown' }
        );

        return;
      }

    } catch (e) {
      console.error('Admin callback error:', e);

      try {
        await bot.answerCallbackQuery(query.id, {
          text: '❌ Operation failed',
          show_alert: true
        });
      } catch (_) {}
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
        userCache[String(tid)] = { name, phone, balance, bonusBalance: parseFloat(u.bonus_balance) || 0, winBalance: parseFloat(u.win_balance) || 0, isAdmin: isAdminPhone(phone) };
      } catch(e){ console.error('createUser error:', e.message); }
    } else {
      userCache[String(tid)] = { name, phone, balance:10, bonusBalance:10, winBalance:0, isAdmin: isAdminPhone(phone) };
    }
    bot.sendMessage(msg.chat.id,
      `✅ *Registered Successfully!*\n\n👤 Name: *${name}*\n📱 Phone: ${phone}\n💰 Balance: *${balance} ETB*\n\nDeposit ETB to start playing! 🎱`,
      { reply_markup: MAIN_MENU(tid) }
    );
  });

  console.log('🤖 Telegram bot started!');
}
