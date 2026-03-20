CREATE TABLE IF NOT EXISTS player_pp_rates (
  nhl_player_id TEXT NOT NULL,
  player_name   TEXT,
  team          TEXT,
  season        TEXT NOT NULL DEFAULT '20242025',
  pp_shots_per60 REAL NOT NULL,
  pp_toi_per60   REAL,
  source        TEXT NOT NULL DEFAULT 'nst',
  updated_at    TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (nhl_player_id, season)
);

CREATE INDEX IF NOT EXISTS idx_player_pp_rates_player_season
  ON player_pp_rates (nhl_player_id, season);
