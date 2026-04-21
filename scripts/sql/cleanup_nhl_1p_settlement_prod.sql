-- Production cleanup for NHL 1P settlement data hygiene
-- Removes non-settled and duplicate settlement rows that pollute telemetry
-- IMPORTANT:
--   - Stop worker first (single-writer DB contract).
--   - Run this script in PREVIEW mode first (default ROLLBACK).
--   - Only switch final ROLLBACK -> COMMIT after reviewing candidate rows and backup table.
--
-- Usage:
--   CHEDDAR_DB_PATH=/opt/data/cheddar-prod.db sqlite3 "$CHEDDAR_DB_PATH" < scripts/sql/cleanup_nhl_1p_settlement_prod.sql

.headers on
.mode column

BEGIN IMMEDIATE;

DROP VIEW IF EXISTS _nhl_1p_audit;
CREATE TEMP VIEW _nhl_1p_audit AS
SELECT
  cr.id,
  cr.card_id,
  cr.game_id,
  LOWER(COALESCE(cr.card_type, 'unknown')) AS card_type,
  LOWER(COALESCE(cr.status, 'unknown')) AS status,
  cr.settled_at,
  cr.created_at,
  ROW_NUMBER() OVER (
    PARTITION BY cr.game_id, LOWER(COALESCE(cr.card_type, ''))
    ORDER BY
      datetime(COALESCE(cr.settled_at, cp.created_at)) DESC,
      datetime(cp.created_at) DESC,
      cr.card_id DESC
  ) AS rank_by_game_card_type,
  CASE WHEN LOWER(COALESCE(cr.status, '')) <> 'settled' THEN 1 ELSE 0 END AS not_settled,
  CASE WHEN cr.settled_at IS NULL THEN 1 ELSE 0 END AS no_settled_at
FROM card_results cr
LEFT JOIN card_payloads cp ON cp.id = cr.card_id
LEFT JOIN game_results gr ON gr.game_id = cr.game_id
WHERE LOWER(COALESCE(cr.sport, '')) = 'nhl'
  AND LOWER(COALESCE(cr.card_type, '')) IN ('nhl-pace-1p', 'nhl-1p-call')
  AND LOWER(COALESCE(gr.status, '')) = 'final';

DROP TABLE IF EXISTS _cleanup_candidates;
CREATE TEMP TABLE _cleanup_candidates AS
SELECT *
FROM _nhl_1p_audit
WHERE not_settled = 1
  OR no_settled_at = 1
  OR rank_by_game_card_type > 1;

SELECT
  COUNT(*) AS candidate_rows,
  SUM(CASE WHEN not_settled = 1 THEN 1 ELSE 0 END) AS not_settled_rows,
  SUM(CASE WHEN no_settled_at = 1 THEN 1 ELSE 0 END) AS no_settled_at_rows,
  SUM(CASE WHEN rank_by_game_card_type > 1 THEN 1 ELSE 0 END) AS duplicate_rows,
  COUNT(DISTINCT game_id || '|' || card_type) AS affected_game_card_keys
FROM _cleanup_candidates;

SELECT
  id,
  card_id,
  game_id,
  card_type,
  status,
  rank_by_game_card_type,
  settled_at,
  created_at,
  not_settled,
  no_settled_at
FROM _cleanup_candidates
ORDER BY 
  game_id ASC,
  card_type ASC,
  rank_by_game_card_type DESC,
  settled_at DESC,
  created_at DESC,
  id DESC
LIMIT 500;

-- Persist backup (in the same DB) before delete.
DROP TABLE IF EXISTS card_results_cleanup_backup_nhl_1p_prod;
CREATE TABLE card_results_cleanup_backup_nhl_1p_prod AS
SELECT *
FROM card_results
WHERE id IN (SELECT id FROM _cleanup_candidates);

DELETE FROM card_results
WHERE id IN (SELECT id FROM _cleanup_candidates);

SELECT changes() AS deleted_rows;

-- Preview mode by default: keep ROLLBACK.
-- After review, re-run and change this final line to COMMIT.
ROLLBACK;
-- PROD cleanup for NHL 1P settlement telemetry pollution.
--
-- IMPORTANT:
-- - Stop worker first (single-writer DB contract).
-- - Run this script in PREVIEW mode first (default ROLLBACK).
-- - Only switch final ROLLBACK -> COMMIT after reviewing candidates + backup.
--
-- Usage:
--   CHEDDAR_DB_PATH=/opt/data/cheddar-prod.db sqlite3 "$CHEDDAR_DB_PATH" < scripts/sql/cleanup_nhl_1p_settlement_prod.sql

.headers on
.mode column

BEGIN IMMEDIATE;

DROP VIEW IF EXISTS _nhl_1p_cleanup_audit;
CREATE TEMP VIEW _nhl_1p_cleanup_audit AS
WITH source_rows AS (
  SELECT
    cr.id,
    cr.card_id,
    cr.game_id,
    LOWER(COALESCE(cr.card_type, '')) AS card_type,
    LOWER(COALESCE(cr.status, '')) AS status,
    UPPER(COALESCE(cr.result, '')) AS result,
    cr.settled_at,
    cp.created_at,
    ROW_NUMBER() OVER (
      PARTITION BY cr.game_id, LOWER(COALESCE(cr.card_type, ''))
      ORDER BY
        CASE WHEN LOWER(COALESCE(cr.status, '')) = 'settled' THEN 1 ELSE 0 END DESC,
        datetime(COALESCE(cr.settled_at, cp.created_at)) DESC,
        datetime(cp.created_at) DESC,
        cr.card_id DESC
    ) AS canonical_rank,
    COUNT(*) OVER (
      PARTITION BY cr.game_id, LOWER(COALESCE(cr.card_type, ''))
    ) AS dup_count
  FROM card_results cr
  INNER JOIN card_payloads cp ON cp.id = cr.card_id
  INNER JOIN game_results gr ON gr.game_id = cr.game_id
  WHERE LOWER(COALESCE(cr.sport, '')) = 'nhl'
    AND LOWER(COALESCE(cr.card_type, '')) IN ('nhl-pace-1p', 'nhl-1p-call')
    AND LOWER(COALESCE(gr.status, '')) = 'final'
)
SELECT
  id,
  card_id,
  game_id,
  card_type,
  status,
  result,
  settled_at,
  created_at,
  canonical_rank,
  dup_count,
  CASE WHEN status <> 'settled' THEN 1 ELSE 0 END AS non_settled_status,
  CASE WHEN status = 'settled' AND settled_at IS NULL THEN 1 ELSE 0 END AS missing_settled_at,
  CASE
    WHEN status = 'settled' AND result NOT IN ('WIN', 'LOSS', 'PUSH', 'VOID') THEN 1
    ELSE 0
  END AS invalid_settled_result,
  CASE WHEN canonical_rank > 1 THEN 1 ELSE 0 END AS duplicate_non_canonical
FROM source_rows;

DROP TABLE IF EXISTS _cleanup_candidates;
CREATE TEMP TABLE _cleanup_candidates AS
SELECT *
FROM _nhl_1p_cleanup_audit
WHERE non_settled_status = 1
   OR missing_settled_at = 1
   OR invalid_settled_result = 1
   OR duplicate_non_canonical = 1;

SELECT
  COUNT(*) AS candidate_rows,
  SUM(non_settled_status) AS non_settled_status_rows,
  SUM(missing_settled_at) AS missing_settled_at_rows,
  SUM(invalid_settled_result) AS invalid_settled_result_rows,
  SUM(duplicate_non_canonical) AS duplicate_non_canonical_rows
FROM _cleanup_candidates;

SELECT
  game_id,
  card_type,
  COUNT(*) AS candidate_count
FROM _cleanup_candidates
GROUP BY game_id, card_type
ORDER BY candidate_count DESC, game_id
LIMIT 50;

SELECT
  id,
  card_id,
  game_id,
  card_type,
  status,
  result,
  settled_at,
  created_at,
  canonical_rank,
  dup_count,
  non_settled_status,
  missing_settled_at,
  invalid_settled_result,
  duplicate_non_canonical
FROM _cleanup_candidates
ORDER BY datetime(COALESCE(settled_at, created_at)) DESC, id DESC
LIMIT 500;

-- Persist backup before delete.
DROP TABLE IF EXISTS card_results_cleanup_backup_nhl_1p_prod;
CREATE TABLE card_results_cleanup_backup_nhl_1p_prod AS
SELECT *
FROM card_results
WHERE id IN (SELECT id FROM _cleanup_candidates);

DELETE FROM card_results
WHERE id IN (SELECT id FROM _cleanup_candidates);

SELECT changes() AS deleted_rows;

-- Preview mode by default: keep ROLLBACK.
-- After review, re-run and change this final line to COMMIT.
ROLLBACK;
