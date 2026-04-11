-- WI-0831: Per-market isotonic regression calibration models.
-- One row per (sport, market_type); upserted by fit_calibration_models.js.
-- market_type uses the same token as calibration_predictions.market (e.g. NHL_TOTAL, NBA_TOTAL, MLB_F5_TOTAL).
CREATE TABLE IF NOT EXISTS calibration_models (
  sport            TEXT NOT NULL,
  market_type      TEXT NOT NULL,
  fitted_at        TEXT NOT NULL,
  breakpoints_json TEXT NOT NULL,
  n_samples        INTEGER NOT NULL,
  isotonic_brier   REAL NOT NULL,
  PRIMARY KEY (sport, market_type)
);

CREATE INDEX IF NOT EXISTS idx_calibration_models_market
  ON calibration_models(sport, market_type);
