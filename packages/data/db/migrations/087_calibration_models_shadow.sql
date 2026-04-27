-- WI-1186: Shadow staging table for calibration model fits.
-- New fits are written here first; the fit job promotes to calibration_models
-- only if isotonic_brier improves by >= epsilon versus the incumbent.
CREATE TABLE IF NOT EXISTS calibration_models_shadow (
  sport            TEXT NOT NULL,
  market_type      TEXT NOT NULL,
  fitted_at        TEXT NOT NULL,
  breakpoints_json TEXT NOT NULL,
  n_samples        INTEGER NOT NULL,
  isotonic_brier   REAL NOT NULL,
  promoted         INTEGER NOT NULL DEFAULT 0,
  promoted_at      TEXT,
  PRIMARY KEY (sport, market_type)
);
