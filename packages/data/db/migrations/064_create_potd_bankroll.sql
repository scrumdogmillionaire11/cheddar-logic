-- Migration 064: Create POTD bankroll ledger
--
-- Append-only event ledger for bankroll initialization, play posting, and
-- settlement mirroring.

CREATE TABLE IF NOT EXISTS potd_bankroll (
  id TEXT PRIMARY KEY,
  event_date TEXT NOT NULL,
  event_type TEXT NOT NULL,
  play_id TEXT,
  card_id TEXT,
  amount_before REAL NOT NULL,
  amount_change REAL NOT NULL,
  amount_after REAL NOT NULL,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (play_id) REFERENCES potd_plays(id)
);

CREATE INDEX IF NOT EXISTS idx_potd_bankroll_event_date
  ON potd_bankroll(event_date DESC);

CREATE INDEX IF NOT EXISTS idx_potd_bankroll_play_id
  ON potd_bankroll(play_id);
