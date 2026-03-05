-- Migration: Create pipeline_health table
-- Purpose: Track pipeline health check results for UI visibility and alerting
-- Run timestamp: AUTO-INSERTED BY MIGRATION ENGINE

CREATE TABLE pipeline_health (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  phase TEXT NOT NULL,              -- 'schedule', 'odds', 'cards', 'settlement'
  check_name TEXT NOT NULL,         -- 'freshness', 'backlog', etc.
  status TEXT NOT NULL,             -- 'ok', 'warning', 'failed'
  reason TEXT,                      -- Human-readable reason for the status
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_pipeline_health_phase ON pipeline_health(phase);
CREATE INDEX idx_pipeline_health_status ON pipeline_health(status);
CREATE INDEX idx_pipeline_health_created_at ON pipeline_health(created_at);
