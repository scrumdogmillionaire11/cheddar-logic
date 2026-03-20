-- WI-0531: Add L10/L5 rolling split columns to player_pp_rates.
-- SQLite requires separate ALTER TABLE statements for each column.
ALTER TABLE player_pp_rates ADD COLUMN pp_l10_shots_per60 REAL;
ALTER TABLE player_pp_rates ADD COLUMN pp_l5_shots_per60  REAL;
