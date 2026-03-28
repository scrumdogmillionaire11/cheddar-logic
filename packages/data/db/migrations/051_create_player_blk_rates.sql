CREATE TABLE IF NOT EXISTS player_blk_rates (
  nhl_player_id TEXT NOT NULL,
  player_name TEXT,
  team TEXT,
  season TEXT NOT NULL DEFAULT '20242025',
  ev_blocks_season_per60 REAL,
  ev_blocks_l10_per60 REAL,
  ev_blocks_l5_per60 REAL,
  pk_blocks_season_per60 REAL,
  pk_blocks_l10_per60 REAL,
  pk_blocks_l5_per60 REAL,
  pk_toi_per_game REAL,
  source TEXT NOT NULL DEFAULT 'nst',
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (nhl_player_id, season)
);

CREATE INDEX IF NOT EXISTS idx_player_blk_rates_player_season
  ON player_blk_rates (nhl_player_id, season);
