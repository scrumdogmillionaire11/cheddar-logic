DROP INDEX IF EXISTS idx_player_prop_lines_unique;

CREATE UNIQUE INDEX IF NOT EXISTS idx_player_prop_lines_unique
  ON player_prop_lines (sport, game_id, player_name, prop_type, period, bookmaker, line);
