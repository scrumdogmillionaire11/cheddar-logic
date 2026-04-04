CREATE TABLE IF NOT EXISTS nhl_goalie_starters (
  game_id    TEXT NOT NULL,
  team_id    TEXT NOT NULL,
  goalie_id  TEXT,
  goalie_name TEXT,
  confirmed  BOOLEAN NOT NULL DEFAULT 0,
  source     TEXT NOT NULL DEFAULT 'NHL_API',
  fetched_at TEXT NOT NULL,
  PRIMARY KEY (game_id, team_id)
);
