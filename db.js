/**
 * db.js — PostgreSQL database layer for Kefay Bingo
 * 
 * Install: npm install pg
 * Set env:  DATABASE_URL=postgresql://user:pass@host:5432/beteseb_bingo
 */

const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
  connectionTimeoutMillis: 15000,
  idleTimeoutMillis: 30000,
  max: 10
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

  async updateBalance(userId, amount) {
    const { rows } = await pool.query(
      'UPDATE users SET balance=$1 WHERE id=$2 RETURNING balance',
      [amount, userId]
    );
    return rows[0]?.balance;
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
  }

};
