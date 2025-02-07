const { pool } = require('./index');

const queries = {
  // Game management
  async createGame(gameId) {
    return pool.query(
      'INSERT INTO games (game_id) VALUES ($1) RETURNING *',
      [gameId]
    );
  },

  async updateGameStatus(gameId, status, endTime = null) {
    return pool.query(
      'UPDATE games SET status = $1, end_time = $2 WHERE game_id = $3',
      [status, endTime, gameId]
    );
  },

  // Player management
  async createOrUpdatePlayer(playerName) {
    return pool.query(
      `INSERT INTO players (name, games_played) 
       VALUES ($1, 1)
       ON CONFLICT (name) 
       DO UPDATE SET games_played = players.games_played + 1
       RETURNING *`,
      [playerName]
    );
  },

  // Round tracking
  async recordRound(gameId, roundNumber, trumpSuit) {
    return pool.query(
      `INSERT INTO game_rounds (game_id, round_number, trump_suit)
       VALUES ($1, $2, $3)
       RETURNING id`,
      [gameId, roundNumber, trumpSuit]
    );
  },

  // Round results
  async recordRoundResult(gameId, roundId, playerId, prediction, tricksWon, score, plumps) {
    return pool.query(
      `INSERT INTO round_results 
       (game_id, round_id, player_id, prediction, tricks_won, score, plumps)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [gameId, roundId, playerId, prediction, tricksWon, score, plumps]
    );
  },

  // Statistics queries for Power BI
  async getPlayerStats() {
    return pool.query(`
      SELECT 
        p.name,
        p.games_played,
        p.total_wins,
        COUNT(rr.id) as total_rounds_played,
        SUM(rr.score) as total_score,
        SUM(rr.plumps) as total_plumps,
        ROUND(AVG(rr.score)::numeric, 2) as avg_score_per_round
      FROM players p
      LEFT JOIN round_results rr ON p.id = rr.player_id
      GROUP BY p.id
      ORDER BY total_score DESC
    `);
  },

  async getGameHistory(limit = 10) {
    return pool.query(`
      SELECT 
        g.game_id,
        g.start_time,
        g.end_time,
        COUNT(DISTINCT rr.player_id) as player_count,
        COUNT(DISTINCT gr.round_number) as rounds_played,
        STRING_AGG(DISTINCT p.name, ', ') as players
      FROM games g
      LEFT JOIN game_rounds gr ON g.game_id = gr.game_id
      LEFT JOIN round_results rr ON g.game_id = rr.game_id
      LEFT JOIN players p ON rr.player_id = p.id
      GROUP BY g.game_id, g.start_time, g.end_time
      ORDER BY g.start_time DESC
      LIMIT $1
    `, [limit]);
  }
};

module.exports = queries; 