-- Audit suspected backfill-derived card_display_log rows.
-- Conservative heuristics only (high-confidence anomalies + optional medium signals).
--
-- Usage:
--   sqlite3 "$CHEDDAR_DB_PATH" < scripts/sql/audit_card_display_log_backfill.sql

.headers on
.mode column

DROP VIEW IF EXISTS _display_log_backfill_audit;
CREATE TEMP VIEW _display_log_backfill_audit AS
SELECT
  cdl.id,
  cdl.pick_id,
  UPPER(COALESCE(cdl.sport, 'UNKNOWN')) AS sport,
  cdl.run_id AS cdl_run_id,
  cp.run_id AS cp_run_id,
  cdl.game_id AS cdl_game_id,
  cp.game_id AS cp_game_id,
  cdl.displayed_at,
  cp.created_at,
  cdl.odds_book,
  json_extract(cp.payload_data, '$.odds_context.bookmaker') AS payload_bookmaker,
  cdl.api_endpoint,
  cr.status AS card_result_status,
  cr.result AS card_result_result,
  cr.settled_at,
  CASE WHEN cp.id IS NULL THEN 1 ELSE 0 END AS missing_payload,
  CASE WHEN cr.id IS NULL THEN 1 ELSE 0 END AS missing_card_result,
  CASE
    WHEN cp.id IS NOT NULL AND COALESCE(cdl.run_id, '') <> COALESCE(cp.run_id, '')
    THEN 1 ELSE 0
  END AS run_id_mismatch,
  CASE
    WHEN cp.id IS NOT NULL AND COALESCE(cdl.game_id, '') <> COALESCE(cp.game_id, '')
    THEN 1 ELSE 0
  END AS game_id_mismatch,
  CASE
    WHEN cp.id IS NOT NULL
      AND json_extract(cp.payload_data, '$.odds_context.bookmaker') IS NOT NULL
      AND cdl.odds_book IS NULL
    THEN 1 ELSE 0
  END AS dropped_bookmaker,
  CASE
    WHEN cp.id IS NOT NULL
      AND datetime(cdl.displayed_at) < datetime(cp.created_at, '-5 minutes')
    THEN 1 ELSE 0
  END AS displayed_before_created,
  CASE
    WHEN cp.id IS NULL
      OR cr.id IS NULL
      OR (cp.id IS NOT NULL AND COALESCE(cdl.run_id, '') <> COALESCE(cp.run_id, ''))
      OR (cp.id IS NOT NULL AND COALESCE(cdl.game_id, '') <> COALESCE(cp.game_id, ''))
      OR (cp.id IS NOT NULL AND datetime(cdl.displayed_at) < datetime(cp.created_at, '-5 minutes'))
    THEN 'high'
    WHEN cp.id IS NOT NULL
      AND json_extract(cp.payload_data, '$.odds_context.bookmaker') IS NOT NULL
      AND cdl.odds_book IS NULL
    THEN 'medium'
    ELSE 'none'
  END AS suspicion_tier
FROM card_display_log cdl
LEFT JOIN card_payloads cp ON cp.id = cdl.pick_id
LEFT JOIN card_results cr ON cr.card_id = cdl.pick_id;

SELECT
  COUNT(*) AS total_display_rows,
  SUM(CASE WHEN card_result_status = 'settled' THEN 1 ELSE 0 END) AS settled_rows,
  SUM(CASE WHEN card_result_status = 'pending' THEN 1 ELSE 0 END) AS pending_rows,
  SUM(CASE WHEN suspicion_tier = 'high' THEN 1 ELSE 0 END) AS high_suspicion,
  SUM(CASE WHEN suspicion_tier = 'medium' THEN 1 ELSE 0 END) AS medium_suspicion
FROM _display_log_backfill_audit;

SELECT
  sport,
  COUNT(*) AS rows,
  SUM(CASE WHEN card_result_status = 'settled' THEN 1 ELSE 0 END) AS settled_rows,
  SUM(CASE WHEN suspicion_tier = 'high' THEN 1 ELSE 0 END) AS high_suspicion,
  SUM(CASE WHEN suspicion_tier = 'medium' THEN 1 ELSE 0 END) AS medium_suspicion
FROM _display_log_backfill_audit
GROUP BY sport
ORDER BY rows DESC;

SELECT
  id,
  pick_id,
  sport,
  cdl_game_id,
  cp_game_id,
  cdl_run_id,
  cp_run_id,
  displayed_at,
  created_at,
  card_result_status,
  card_result_result,
  settled_at,
  odds_book,
  payload_bookmaker,
  api_endpoint,
  suspicion_tier,
  missing_payload,
  missing_card_result,
  run_id_mismatch,
  game_id_mismatch,
  dropped_bookmaker,
  displayed_before_created
FROM _display_log_backfill_audit
WHERE suspicion_tier <> 'none'
ORDER BY
  CASE suspicion_tier WHEN 'high' THEN 0 ELSE 1 END,
  datetime(COALESCE(settled_at, displayed_at)) DESC,
  id DESC
LIMIT 300;

DROP VIEW IF EXISTS _display_log_backfill_audit;
