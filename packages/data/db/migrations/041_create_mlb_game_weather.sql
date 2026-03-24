CREATE TABLE IF NOT EXISTS mlb_game_weather (
  id          TEXT PRIMARY KEY,
  game_id     TEXT NOT NULL,
  game_date   TEXT NOT NULL,
  venue_name  TEXT,
  home_team   TEXT,
  temp_f      REAL,
  wind_mph    REAL,
  wind_dir    TEXT,
  conditions  TEXT,
  updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (game_date, home_team)
);

CREATE INDEX IF NOT EXISTS idx_mlb_game_weather_game_date_home
  ON mlb_game_weather (game_date, home_team);
