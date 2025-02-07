-- Games table to track all games
CREATE TABLE IF NOT EXISTS games (
    id SERIAL PRIMARY KEY,
    game_id VARCHAR(6) UNIQUE NOT NULL,
    start_time TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    end_time TIMESTAMP,
    player_count INTEGER DEFAULT 4,
    total_rounds INTEGER,
    status VARCHAR(20) DEFAULT 'active'
);

-- Players table for player statistics
CREATE TABLE IF NOT EXISTS players (
    id SERIAL PRIMARY KEY,
    name VARCHAR(100) UNIQUE NOT NULL,
    games_played INTEGER DEFAULT 0,
    total_wins INTEGER DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Game rounds for detailed round analysis
CREATE TABLE IF NOT EXISTS game_rounds (
    id SERIAL PRIMARY KEY,
    game_id VARCHAR(6) REFERENCES games(game_id),
    round_number INTEGER NOT NULL,
    trump_suit VARCHAR(10),
    timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Round results for detailed scoring
CREATE TABLE IF NOT EXISTS round_results (
    id SERIAL PRIMARY KEY,
    game_id VARCHAR(6) REFERENCES games(game_id),
    round_id INTEGER REFERENCES game_rounds(id),
    player_id INTEGER REFERENCES players(id),
    prediction INTEGER NOT NULL,
    tricks_won INTEGER NOT NULL,
    score INTEGER NOT NULL,
    plumps INTEGER DEFAULT 0
); 