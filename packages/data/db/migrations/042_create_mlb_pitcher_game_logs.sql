CREATE TABLE IF NOT EXISTS mlb_pitcher_game_logs (
  id              TEXT PRIMARY KEY,
  mlb_pitcher_id  INTEGER NOT NULL,
  game_pk         INTEGER NOT NULL,
  game_date       TEXT NOT NULL,
  season          INTEGER NOT NULL,
  innings_pitched REAL,
  strikeouts      INTEGER,
  walks           INTEGER,
  hits            INTEGER,
  earned_runs     INTEGER,
  opponent        TEXT,
  home_away       TEXT,
  updated_at      TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (mlb_pitcher_id, game_pk)
);

CREATE INDEX IF NOT EXISTS idx_mlb_pitcher_game_logs_pitcher_date
  ON mlb_pitcher_game_logs (mlb_pitcher_id, game_date);

CREATE INDEX IF NOT EXISTS idx_mlb_pitcher_game_logs_season
  ON mlb_pitcher_game_logs (mlb_pitcher_id, season, game_date);
