-- Migration: Fix sport normalization to lowercase for consistency with odds_snapshots and games

-- Step 1: Temporarily disable foreign keys
PRAGMA foreign_keys=OFF;

-- Clean up partial tables from any failed runs
DROP TABLE IF EXISTS card_payloads_new;
DROP TABLE IF EXISTS card_results_new;

-- Step 2: Create new card_payloads table with lowercase CHECK constraint
CREATE TABLE card_payloads_new (
  id TEXT PRIMARY KEY,
  game_id TEXT NOT NULL,
  sport TEXT NOT NULL CHECK (sport IN ('nba', 'nhl', 'ncaam', 'soccer', 'mlb', 'nfl', 'fpl')),
  card_type TEXT NOT NULL,
  card_title TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT,
  payload_data TEXT NOT NULL,
  model_output_ids TEXT,
  metadata TEXT,
  run_id TEXT,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (game_id) REFERENCES games(game_id)
);

-- Step 3: Copy data with lowercased sport
INSERT INTO card_payloads_new
SELECT 
  id,
  game_id,
  LOWER(sport),
  card_type,
  card_title,
  created_at,
  expires_at,
  payload_data,
  model_output_ids,
  metadata,
  run_id,
  updated_at
FROM card_payloads;

-- Step 4: Drop old table and rename new one
DROP TABLE card_payloads;
ALTER TABLE card_payloads_new RENAME TO card_payloads;

-- Step 5: Recreate indexes
CREATE INDEX IF NOT EXISTS idx_card_payloads_game_id ON card_payloads(game_id);
CREATE INDEX IF NOT EXISTS idx_card_payloads_sport ON card_payloads(sport);
CREATE INDEX IF NOT EXISTS idx_card_payloads_card_type ON card_payloads(card_type);
CREATE INDEX IF NOT EXISTS idx_card_payloads_expires_at ON card_payloads(expires_at);
CREATE INDEX IF NOT EXISTS idx_card_payloads_run_id ON card_payloads(run_id);

-- Step 6: Do the same for card_results
CREATE TABLE card_results_new (
  id TEXT PRIMARY KEY,
  card_id TEXT NOT NULL,
  game_id TEXT NOT NULL,
  sport TEXT NOT NULL CHECK (sport IN ('nba', 'nhl', 'ncaam', 'soccer', 'mlb', 'nfl', 'fpl')),
  card_type TEXT NOT NULL,
  recommended_bet_type TEXT NOT NULL,
  market_key TEXT,
  market_type TEXT,
  selection TEXT,
  line REAL,
  locked_price INTEGER,
  status TEXT NOT NULL,
  result TEXT,
  settled_at TEXT,
  pnl_units REAL,
  metadata TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (card_id) REFERENCES card_payloads(id)
);

INSERT INTO card_results_new
SELECT 
  id,
  card_id,
  game_id,
  LOWER(sport),
  card_type,
  recommended_bet_type,
  market_key,
  market_type,
  selection,
  line,
  locked_price,
  status,
  result,
  settled_at,
  pnl_units,
  metadata,
  created_at,
  updated_at
FROM card_results;

DROP TABLE card_results;
ALTER TABLE card_results_new RENAME TO card_results;

CREATE INDEX IF NOT EXISTS idx_card_results_card_id ON card_results(card_id);
CREATE INDEX IF NOT EXISTS idx_card_results_game_id ON card_results(game_id);
CREATE INDEX IF NOT EXISTS idx_card_results_sport ON card_results(sport);
CREATE INDEX IF NOT EXISTS idx_card_results_status ON card_results(status);

-- Step 7: Re-enable foreign keys
PRAGMA foreign_keys=ON;
