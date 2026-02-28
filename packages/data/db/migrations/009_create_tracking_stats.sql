-- Migration: Create tracking_stats table
-- Purpose: Pre-computed performance analytics with deep segmentation

CREATE TABLE tracking_stats (
  id TEXT PRIMARY KEY,
  stat_key TEXT NOT NULL UNIQUE,
  sport TEXT,
  market_type TEXT,
  direction TEXT,
  confidence_tier TEXT,
  driver_key TEXT,
  time_period TEXT,
  total_cards INTEGER NOT NULL DEFAULT 0,
  settled_cards INTEGER NOT NULL DEFAULT 0,
  wins INTEGER NOT NULL DEFAULT 0,
  losses INTEGER NOT NULL DEFAULT 0,
  pushes INTEGER NOT NULL DEFAULT 0,
  total_pnl_units REAL NOT NULL DEFAULT 0.0,
  win_rate REAL,
  avg_pnl_per_card REAL,
  confidence_calibration REAL,
  metadata TEXT,
  computed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_tracking_stats_sport ON tracking_stats(sport);
CREATE INDEX idx_tracking_stats_market_type ON tracking_stats(market_type);
CREATE INDEX idx_tracking_stats_confidence_tier ON tracking_stats(confidence_tier);
CREATE INDEX idx_tracking_stats_time_period ON tracking_stats(time_period);
CREATE INDEX idx_tracking_stats_computed_at ON tracking_stats(computed_at);

-- stat_key format: "{sport}|{market}|{direction}|{confidence_tier}|{driver}|{period}"
-- Example: "NHL|moneyline|HOME|60-70|goalie|2026-02"
-- Use pipe-delimited for easy parsing and dimension drill-down

-- Market types: 'moneyline' | 'spread' | 'total' | 'all'
-- Direction: 'HOME' | 'AWAY' | 'OVER' | 'UNDER' | 'all'
-- Confidence tiers: '<60' | '60-70' | '70-80' | '>80' | 'all'
-- Time periods: 'YYYY-MM' | 'YYYY-Wnn' | 'season-YYYY' | 'all-time'
