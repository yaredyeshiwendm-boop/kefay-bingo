/**
 * db.js — PostgreSQL database layer for Kefay Bingo
 * 
 * Install: npm install pg
 * Set env:  DATABASE_URL=postgresql://user:pass@host:5432/beteseb_bingo
 */

const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

module.exports = {   async q(text, params = []) {
    const { rows } = await pool.query(text, params);
    return rows;
  },

  async getUser(telegramId) {
    const { rows } = await pool.query(
      'SELECT * FROM users WHERE telegram_id=$1',
      [telegramId]
    );
    return rows[0] || null;
  },

  async createUser(telegramId, name, phone) {
    const { rows } = await pool.query(
      `INSERT INTO users(telegram_id, name, phone)
       VALUES($1, $2, $3)
       ON CONFLICT(telegram_id)
       DO UPDATE SET last_seen=NOW(), name=$2
       RETURNING *`,
      [telegramId, name, phone]
    );
    return rows[0];
  },
  // ── User operations ──
  async registerUser(telegramId, name, phone) {
    const { rows } = await pool.query(
      `INSERT INTO users(telegram_id, name, phone)
       VALUES($1, $2, $3)
       ON CONFLICT(telegram_id) DO UPDATE SET last_seen=NOW(), name=$2
       RETURNING *`,
      [telegramId, name, phone]
    );
    return rows[0];
  },

  async getUserByTelegramId(telegramId) {
    const { rows } = await pool.query(
      'SELECT * FROM users WHERE telegram_id=$1', [telegramId]
    );
    return rows[0] || null;
  },


  async deductStake(userId, amount, gameId) {
    const { rows } = await pool.query(
      'SELECT deduct_stake($1,$2,$3)', [userId, amount, gameId]
    );
    return rows[0].deduct_stake;
  },

  async awardWin(userId, amount, gameId) {
    const { rows } = await pool.query(
      'SELECT award_win($1,$2,$3)', [userId, amount, gameId]
    );
    return rows[0].award_win;
  },

  // ── Game operations ──
  async createGame(roomId, stakeId, stakeAmount) {
    const { rows } = await pool.query(
      `INSERT INTO games(room_id, stake_id, stake_amount, pot, started_at)
       VALUES($1,$2,$3,0,NOW()) RETURNING *`,
      [roomId, stakeId, stakeAmount]
    );
    return rows[0];
  },

  async addParticipant(gameId, userId, cardId) {
    await pool.query(
      `INSERT INTO game_participants(game_id, user_id, card_id)
       VALUES($1,$2,$3) ON CONFLICT(game_id,user_id) DO NOTHING`,
      [gameId, userId, cardId]
    );
  },

  async updateGamePot(gameId, pot) {
    await pool.query('UPDATE games SET pot=$1 WHERE id=$2', [pot, gameId]);
  },

  async updateCalledNumbers(gameId, calledNumbers) {
    await pool.query(
      'UPDATE games SET called_numbers=$1 WHERE id=$2',
      [calledNumbers, gameId]
    );
  },

  async endGame(gameId, winnerUserIds, winAmount, isSplit) {
    await pool.query(
      `UPDATE games SET status='finished', winner_ids=$1, win_amount=$2, is_split=$3, ended_at=NOW()
       WHERE id=$4`,
      [winnerUserIds, winAmount, isSplit, gameId]
    );
    if (winnerUserIds.length > 0) {
      await pool.query(
        `UPDATE game_participants SET is_winner=TRUE, amount_won=$1
         WHERE game_id=$2 AND user_id=ANY($3)`,
        [winAmount, gameId, winnerUserIds]
      );
    }
    // Increment total_games for all participants
    await pool.query(
      `UPDATE users SET total_games=total_games+1
       WHERE id IN (SELECT user_id FROM game_participants WHERE game_id=$1)`,
      [gameId]
    );
  },

  async disqualifyParticipant(gameId, userId) {
    await pool.query(
      'UPDATE game_participants SET is_disqualified=TRUE WHERE game_id=$1 AND user_id=$2',
      [gameId, userId]
    );
  },

  // ── Game state for reconnection ──
  async getActiveGame(roomId) {
    const { rows } = await pool.query(
      `SELECT g.*, 
        json_agg(json_build_object('user_id',gp.user_id,'card_id',gp.card_id)) as participants
       FROM games g
       JOIN game_participants gp ON gp.game_id=g.id
       WHERE g.room_id=$1 AND g.status='playing'
       GROUP BY g.id`,
      [roomId]
    );
    return rows[0] || null;
  },


  // ── Leaderboard ──
  async getLeaderboard(limit = 10) {
    const { rows } = await pool.query(
      'SELECT name, total_wins, total_games, total_winnings, win_rate FROM leaderboard LIMIT $1',
      [limit]
    );
    return rows;
  },

  // ── Super Bingo Board Reservations ──

  async reserveSuperBoard(userId, cardId) {
    const { rows } = await pool.query(
      `INSERT INTO super_board_reservations
        (user_id, card_id, stake_amount, jackpot, status)
       VALUES ($1, $2, 50.00, 10000.00, 'locked')
       ON CONFLICT (card_id, status)
       DO NOTHING
       RETURNING *`,
      [userId, cardId]
    );

    return rows[0] || null;
  },

  async getUserSuperBoards(userId) {
    const { rows } = await pool.query(
      `SELECT *
       FROM super_board_reservations
       WHERE user_id=$1
       AND status='locked'
       ORDER BY card_id`,
      [userId]
    );
    return rows;
  },

  async getSuperBoardReservation(cardId) {
    const { rows } = await pool.query(
      `SELECT *
       FROM super_board_reservations
       WHERE card_id=$1
       AND status='locked'
       LIMIT 1`,
      [cardId]
    );
    return rows[0] || null;
  },

  async releaseSuperBoard(userId, cardId) {
    const { rows } = await pool.query(
      `UPDATE super_board_reservations
       SET status='released'
       WHERE user_id=$1
       AND card_id=$2
       AND status='locked'
       RETURNING *`,
      [userId, cardId]
    );
    return rows[0] || null;
  },

  async lockSuperBoardForGame(cardId, gameId) {
    const { rows } = await pool.query(
      `UPDATE super_board_reservations
       SET status='playing', game_id=$1
       WHERE card_id=$2
       AND status='locked'
       RETURNING *`,
      [gameId, cardId]
    );
    return rows[0] || null;
  },

  async finishSuperBoard(cardId) {
    const { rows } = await pool.query(
      `UPDATE super_board_reservations
       SET status='locked', played_at=NOW()
       WHERE card_id=$1
       AND status='playing'
       RETURNING *`,
      [cardId]
    );
    return rows[0] || null;
  },

  // ── Balance & transaction operations ──

  async setWallet(telegramId, bonusBalance, winBalance) {
    const { rows } = await pool.query(
      `UPDATE users
       SET bonus_balance=$1,
           win_balance=$2,
           balance=$1+$2,
           last_seen=NOW()
       WHERE telegram_id=$3
       RETURNING bonus_balance, win_balance, balance`,
      [bonusBalance, winBalance, String(telegramId)]
    );
    return rows[0] || null;
  },

  async logTx(telegramId, type, amount, balanceAfter, reference=null) {
    const { rows } = await pool.query(
      `INSERT INTO transactions
       (user_id, type, amount, balance_after, reference)
       SELECT id, $2, $3, $4, $5
       FROM users
       WHERE telegram_id=$1
       RETURNING *`,
      [String(telegramId), type, amount, balanceAfter, reference]
    );
    return rows[0] || null;
  },

  // ── Game persistence ──

  async saveGame(roomId, stakeId, stakeAmount, pot) {
    const { rows } = await pool.query(
      `INSERT INTO games
       (room_id, stake_id, stake_amount, pot, status, started_at)
       VALUES ($1,$2,$3,$4,'playing',NOW())
       RETURNING id`,
      [roomId, stakeId, stakeAmount, pot]
    );
    return rows[0]?.id || null;
  },

  async addGameParticipant(gameId, telegramId, cardId, disqualified=false) {
    const user = await this.getUser(telegramId);
    if (!user) return null;

    const { rows } = await pool.query(
      `INSERT INTO game_participants
       (game_id, user_id, card_id, is_disqualified)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (game_id,user_id)
       DO UPDATE SET
         card_id=EXCLUDED.card_id,
         is_disqualified=EXCLUDED.is_disqualified
       RETURNING *`,
      [gameId, user.id, cardId, !!disqualified]
    );

    return rows[0] || null;
  },

  // ── Deposit operations ──

  async createDeposit(telegramId, amount, txRef) {
    const user = await this.getUser(telegramId);
    if (!user) return null;

    const { rows } = await pool.query(
      `INSERT INTO deposit_requests
       (user_id, amount, tx_ref, status)
       VALUES ($1,$2,$3,'pending')
       RETURNING id`,
      [user.id, amount, txRef]
    );

    return rows[0]?.id || null;
  },

  async getDeposits(status='pending') {
    const { rows } = await pool.query(
      `SELECT d.*, u.telegram_id, u.name, u.phone
       FROM deposit_requests d
       LEFT JOIN users u ON u.id=d.user_id
       WHERE d.status=$1
       ORDER BY d.created_at DESC`,
      [status]
    );
    return rows;
  },

  async approveDeposit(id) {
    const client = await pool.connect();

    try {
      await client.query('BEGIN');

      const { rows } = await client.query(
        `SELECT d.*, u.telegram_id, u.balance, u.bonus_balance, u.win_balance
         FROM deposit_requests d
         JOIN users u ON u.id=d.user_id
         WHERE d.id=$1 AND d.status='pending'
         FOR UPDATE`,
        [id]
      );

      if (!rows.length) {
        await client.query('ROLLBACK');
        return null;
      }

      const d = rows[0];
      const newBonusBalance = Number(d.bonus_balance) + Number(d.amount);

      await client.query(
        `UPDATE users
         SET bonus_balance=$1, balance=$1+win_balance, last_seen=NOW()
         WHERE id=$2`,
        [newBonusBalance, d.user_id]
      );

      await client.query(
        `UPDATE deposit_requests
         SET status='approved', approved_at=NOW()
         WHERE id=$1`,
        [id]
      );

      await client.query(
        `INSERT INTO transactions
         (user_id,type,amount,balance_after,reference)
         VALUES ($1,'deposit',$2,$3,$4)`,
        [d.user_id, d.amount, newBonusBalance + Number(d.win_balance), `deposit:${id}`]
      );

      await client.query('COMMIT');

      return {
        id,
        telegramId: d.telegram_id,
        amount: Number(d.amount),
        newBalance: newBonusBalance + Number(d.win_balance),
        bonusBalance: newBonusBalance,
        winBalance: Number(d.win_balance) || 0
      };
    } finally {
      client.release();
    }
  },

  async rejectDeposit(id) {
    const { rows } = await pool.query(
      `UPDATE deposit_requests
       SET status='rejected'
       WHERE id=$1 AND status='pending'
       RETURNING *`,
      [id]
    );
    return rows[0] || null;
  },

  // ── Withdrawal operations ──

  async createWithdrawal(telegramId, amount) {
    const client = await pool.connect();

    try {
      await client.query('BEGIN');

      const { rows } = await client.query(
        `SELECT id, telegram_id, balance, bonus_balance, win_balance
         FROM users
         WHERE telegram_id=$1
         FOR UPDATE`,
        [String(telegramId)]
      );

      if (!rows.length) {
        await client.query('ROLLBACK');
        return { error: 'Account not found.' };
      }

      const user = rows[0];

      if (Number(user.win_balance) < Number(amount)) {
        await client.query('ROLLBACK');
        return { error: 'Insufficient Win Balance.' };
      }

      const newWinBalance = Number(user.win_balance) - Number(amount);

      await client.query(
        `UPDATE users SET win_balance=$1, balance=bonus_balance+$1 WHERE id=$2`,
        [newWinBalance, user.id]
      );

      const result = await client.query(
        `INSERT INTO withdrawal_requests
         (user_id, amount, status)
         VALUES ($1,$2,'pending')
         RETURNING id`,
        [user.id, amount]
      );

      await client.query(
        `INSERT INTO transactions
         (user_id,type,amount,balance_after,reference)
         VALUES ($1,'withdrawal',$2,$3,$4)`,
        [user.id, -Number(amount), Number(user.bonus_balance) + newWinBalance, `withdrawal:${result.rows[0].id}`]
      );

      await client.query('COMMIT');

      return {
        id: result.rows[0].id,
        telegramId: user.telegram_id,
        amount: Number(amount),
        newBalance: Number(user.bonus_balance) + newWinBalance,
        bonusBalance: Number(user.bonus_balance),
        winBalance: newWinBalance,
      };
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  },

  async getWithdrawals(status='pending') {
    const { rows } = await pool.query(
      `SELECT w.*, u.telegram_id, u.name, u.phone
       FROM withdrawal_requests w
       LEFT JOIN users u ON u.id=w.user_id
       WHERE w.status=$1
       ORDER BY w.created_at DESC`,
      [status]
    );
    return rows;
  },

  async approveWithdrawal(id) {
    const { rows } = await pool.query(
      `UPDATE withdrawal_requests
       SET status='approved', processed_at=NOW()
       WHERE id=$1 AND status='pending'
       RETURNING *`,
      [id]
    );

    if (!rows.length) return null;

    const w = rows[0];

    const user = await this.getUserById(w.user_id);

    return {
      id,
      telegramId: user?.telegram_id,
      amount: Number(w.amount),
      newBalance: user ? Number(user.balance) : null
    };
  },

  async rejectWithdrawal(id) {
    const client = await pool.connect();

    try {
      await client.query('BEGIN');

      const { rows } = await client.query(
        `SELECT w.*, u.telegram_id, u.balance, u.bonus_balance, u.win_balance
         FROM withdrawal_requests w
         JOIN users u ON u.id=w.user_id
         WHERE w.id=$1 AND w.status='pending'
         FOR UPDATE`,
        [id]
      );

      if (!rows.length) {
        await client.query('ROLLBACK');
        return null;
      }

      const w = rows[0];
      const newWinBalance = Number(w.win_balance) + Number(w.amount);

      await client.query(
        `UPDATE users SET win_balance=$1, balance=bonus_balance+$1 WHERE id=$2`,
        [newWinBalance, w.user_id]
      );

      await client.query(
        `UPDATE withdrawal_requests
         SET status='rejected', processed_at=NOW()
         WHERE id=$1`,
        [id]
      );

      await client.query(
        `INSERT INTO transactions
         (user_id,type,amount,balance_after,reference)
         VALUES ($1,'refund',$2,$3,$4)`,
        [w.user_id, Number(w.amount), Number(w.bonus_balance) + newWinBalance, `withdrawal_refund:${id}`]
      );

      await client.query('COMMIT');

      return {
        id,
        telegramId: w.telegram_id,
        amount: Number(w.amount),
        newBalance: Number(w.bonus_balance) + newWinBalance,
          bonusBalance: Number(w.bonus_balance) || 0,
          winBalance: newWinBalance,
      };
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
    },
};
