#!/usr/bin/env bash
set -euo pipefail

DEFAULT_DB_PATH="/opt/data/cheddar-prod.db"
DB_PATH="${CHEDDAR_DB_PATH:-$DEFAULT_DB_PATH}"
SINCE_HOURS=24
LOOKBACK_HOURS=2
LOOKAHEAD_HOURS=36
SPORT_FILTER=""
LIMIT=50
GAME_IDS=()

usage() {
  cat <<'EOF'
Usage: scripts/diagnose-missing-data-no-plays.sh [options]

Read-only diagnostic for games that surface as MISSING_DATA_NO_PLAYS.

Options:
  --db <path>               SQLite DB path (default: $CHEDDAR_DB_PATH or /opt/data/cheddar-prod.db)
  --since-hours <n>         How far back to inspect failures/job runs (default: 24)
  --lookback-hours <n>      Include games that started this many hours ago (default: 2)
  --lookahead-hours <n>     Include games starting this many hours ahead (default: 36)
  --sport <NBA|NHL|NCAAM>   Restrict to a single sport
  --game-id <id>            Restrict to one game_id (repeatable)
  --limit <n>               Max rows in game tables (default: 50)
  -h, --help                Show help

Examples:
  scripts/diagnose-missing-data-no-plays.sh
  scripts/diagnose-missing-data-no-plays.sh --sport NCAAM --since-hours 48
  scripts/diagnose-missing-data-no-plays.sh --game-id game_ncaab_401703612 --game-id game_nba_401705212
EOF
}

is_integer() {
  [[ "${1:-}" =~ ^[0-9]+$ ]]
}

validate_token() {
  local value="$1"
  local name="$2"
  if [[ ! "$value" =~ ^[A-Za-z0-9._:-]+$ ]]; then
    echo "Invalid $name: $value" >&2
    exit 2
  fi
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --db)
      DB_PATH="${2:-}"
      shift 2
      ;;
    --since-hours)
      SINCE_HOURS="${2:-}"
      shift 2
      ;;
    --lookback-hours)
      LOOKBACK_HOURS="${2:-}"
      shift 2
      ;;
    --lookahead-hours)
      LOOKAHEAD_HOURS="${2:-}"
      shift 2
      ;;
    --sport)
      SPORT_FILTER="${2:-}"
      shift 2
      ;;
    --game-id)
      GAME_IDS+=("${2:-}")
      shift 2
      ;;
    --limit)
      LIMIT="${2:-}"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      usage
      exit 2
      ;;
  esac
done

if ! command -v sqlite3 >/dev/null 2>&1; then
  echo "sqlite3 is required but not installed." >&2
  exit 2
fi

if ! is_integer "$SINCE_HOURS" || ! is_integer "$LOOKBACK_HOURS" || ! is_integer "$LOOKAHEAD_HOURS" || ! is_integer "$LIMIT"; then
  echo "--since-hours, --lookback-hours, --lookahead-hours, and --limit must be non-negative integers." >&2
  exit 2
fi

if [[ -n "$SPORT_FILTER" ]]; then
  validate_token "$SPORT_FILTER" "sport"
  SPORT_FILTER="${SPORT_FILTER^^}"
fi

if [[ ! -f "$DB_PATH" ]]; then
  echo "DB file not found: $DB_PATH" >&2
  exit 2
fi

if ! sqlite3 "$DB_PATH" "SELECT 1;" >/dev/null 2>&1; then
  echo "Unable to read DB: $DB_PATH" >&2
  exit 2
fi

if (( ${#GAME_IDS[@]} > 0 )); then
  for game_id in "${GAME_IDS[@]}"; do
    validate_token "$game_id" "game_id"
  done
fi

GAME_FILTER_SQL=""
if [[ ${#GAME_IDS[@]} -gt 0 ]]; then
  joined=""
  for game_id in "${GAME_IDS[@]}"; do
    if [[ -n "$joined" ]]; then
      joined+=","
    fi
    joined+="'${game_id}'"
  done
  GAME_FILTER_SQL=" AND g.game_id IN (${joined})"
fi

SPORT_FILTER_SQL=""
if [[ -n "$SPORT_FILTER" ]]; then
  SPORT_FILTER_SQL=" AND UPPER(g.sport) = '${SPORT_FILTER}'"
fi

WINDOW_FILTER_SQL="datetime(g.game_time_utc) BETWEEN datetime('now', '-${LOOKBACK_HOURS} hours') AND datetime('now', '+${LOOKAHEAD_HOURS} hours')"

MISSING_GAME_CTE=$(cat <<SQL
WITH latest_odds AS (
  SELECT game_id, MAX(captured_at) AS captured_at
  FROM odds_snapshots
  GROUP BY game_id
),
latest_odds_rows AS (
  SELECT os.*
  FROM odds_snapshots os
  INNER JOIN latest_odds lo
    ON lo.game_id = os.game_id
   AND lo.captured_at = os.captured_at
),
card_counts AS (
  SELECT
    game_id,
    COUNT(*) AS card_rows,
    MAX(created_at) AS last_card_at,
    SUM(
      CASE
        WHEN json_valid(payload_data)
         AND UPPER(COALESCE(json_extract(payload_data, '$.kind'), 'PLAY')) = 'PLAY'
        THEN 1 ELSE 0
      END
    ) AS play_rows,
    SUM(
      CASE
        WHEN json_valid(payload_data)
         AND UPPER(COALESCE(json_extract(payload_data, '$.kind'), 'PLAY')) = 'EVIDENCE'
        THEN 1 ELSE 0
      END
    ) AS evidence_rows
  FROM card_payloads
  GROUP BY game_id
),
candidate_games AS (
  SELECT
    g.game_id,
    g.sport,
    g.home_team,
    g.away_team,
    g.game_time_utc,
    lor.captured_at AS odds_captured_at,
    IFNULL(cc.card_rows, 0) AS card_rows,
    IFNULL(cc.play_rows, 0) AS play_rows,
    IFNULL(cc.evidence_rows, 0) AS evidence_rows,
    cc.last_card_at,
    lor.h2h_home,
    lor.h2h_away,
    lor.total,
    lor.spread_home,
    lor.spread_away,
    json_extract(lor.raw_data, '$.espn_metrics.source_contract.mapping_ok') AS source_mapping_ok,
    CASE
      WHEN UPPER(g.sport) IN ('NBA', 'NCAAM') THEN
        CASE
          WHEN json_extract(lor.raw_data, '$.espn_metrics.home.metrics.avgPoints') IS NOT NULL
           AND json_extract(lor.raw_data, '$.espn_metrics.away.metrics.avgPoints') IS NOT NULL
           AND json_extract(lor.raw_data, '$.espn_metrics.home.metrics.avgPointsAllowed') IS NOT NULL
           AND json_extract(lor.raw_data, '$.espn_metrics.away.metrics.avgPointsAllowed') IS NOT NULL
          THEN 1 ELSE 0
        END
      WHEN UPPER(g.sport) = 'NHL' THEN
        CASE
          WHEN json_extract(lor.raw_data, '$.espn_metrics.home.metrics.avgGoalsFor') IS NOT NULL
           AND json_extract(lor.raw_data, '$.espn_metrics.away.metrics.avgGoalsFor') IS NOT NULL
           AND json_extract(lor.raw_data, '$.espn_metrics.home.metrics.avgGoalsAgainst') IS NOT NULL
           AND json_extract(lor.raw_data, '$.espn_metrics.away.metrics.avgGoalsAgainst') IS NOT NULL
          THEN 1 ELSE 0
        END
      ELSE NULL
    END AS projection_inputs_complete
  FROM games g
  LEFT JOIN latest_odds_rows lor ON lor.game_id = g.game_id
  LEFT JOIN card_counts cc ON cc.game_id = g.game_id
  WHERE ${WINDOW_FILTER_SQL}
    ${SPORT_FILTER_SQL}
    ${GAME_FILTER_SQL}
    AND (
      lor.h2h_home IS NOT NULL OR
      lor.h2h_away IS NOT NULL OR
      lor.total IS NOT NULL OR
      lor.spread_home IS NOT NULL OR
      lor.spread_away IS NOT NULL
    )
)
SQL
)

echo "[diag] DB: $DB_PATH"
echo "[diag] Window: -${LOOKBACK_HOURS}h to +${LOOKAHEAD_HOURS}h | since=${SINCE_HOURS}h"
if [[ -n "$SPORT_FILTER" ]]; then
  echo "[diag] Sport filter: $SPORT_FILTER"
fi
if [[ ${#GAME_IDS[@]} -gt 0 ]]; then
  echo "[diag] Game filter: ${GAME_IDS[*]}"
fi

echo
echo "=== 1) Candidate games with odds but no cards (direct MISSING_DATA_NO_PLAYS risk) ==="
sqlite3 -header -column "$DB_PATH" "
${MISSING_GAME_CTE}
SELECT
  game_id,
  sport,
  home_team,
  away_team,
  game_time_utc,
  odds_captured_at,
  card_rows,
  play_rows,
  evidence_rows,
  projection_inputs_complete,
  source_mapping_ok
FROM candidate_games
WHERE card_rows = 0
ORDER BY datetime(game_time_utc) ASC
LIMIT ${LIMIT};
"

echo
echo "=== 2) Candidate games with cards but zero PLAY rows (usually PASS_NO_ACTIONABLE_PLAY path) ==="
sqlite3 -header -column "$DB_PATH" "
${MISSING_GAME_CTE}
SELECT
  game_id,
  sport,
  home_team,
  away_team,
  game_time_utc,
  odds_captured_at,
  card_rows,
  play_rows,
  evidence_rows,
  last_card_at,
  projection_inputs_complete,
  source_mapping_ok
FROM candidate_games
WHERE card_rows > 0
  AND play_rows = 0
ORDER BY datetime(game_time_utc) ASC
LIMIT ${LIMIT};
"

echo
echo "=== 3) Ingest failures tied to missing candidate games (last ${SINCE_HOURS}h) ==="
sqlite3 -header -column "$DB_PATH" "
${MISSING_GAME_CTE},
missing_candidates AS (
  SELECT game_id FROM candidate_games WHERE card_rows = 0
)
SELECT
  oif.last_seen,
  oif.sport,
  oif.game_id,
  oif.reason_code,
  oif.reason_detail,
  oif.occurrence_count,
  oif.home_team,
  oif.away_team
FROM odds_ingest_failures oif
INNER JOIN missing_candidates mc ON mc.game_id = oif.game_id
WHERE datetime(oif.last_seen) >= datetime('now', '-${SINCE_HOURS} hours')
ORDER BY datetime(oif.last_seen) DESC
LIMIT ${LIMIT};
"

echo
echo "=== 4) Top ingest failure reasons overall (last ${SINCE_HOURS}h) ==="
sqlite3 -header -column "$DB_PATH" "
SELECT
  reason_code,
  sport,
  COUNT(*) AS rows,
  SUM(occurrence_count) AS occurrences,
  MAX(last_seen) AS last_seen
FROM odds_ingest_failures
WHERE datetime(last_seen) >= datetime('now', '-${SINCE_HOURS} hours')
GROUP BY reason_code, sport
ORDER BY occurrences DESC, rows DESC
LIMIT ${LIMIT};
"

echo
echo "=== 5) Odds pull + model job freshness (last ${SINCE_HOURS}h) ==="
sqlite3 -header -column "$DB_PATH" "
SELECT
  job_name,
  status,
  started_at,
  ended_at,
  error_message
FROM job_runs
WHERE job_name IN ('pull_odds_hourly', 'run_nba_model', 'run_nhl_model', 'run_ncaam_model')
  AND datetime(started_at) >= datetime('now', '-${SINCE_HOURS} hours')
ORDER BY datetime(started_at) DESC
LIMIT ${LIMIT};
"

echo
echo "=== 6) Quick interpretation guide ==="
echo "- card_rows=0 + odds present => UI usually renders MISSING_DATA_NO_PLAYS"
echo "- projection_inputs_complete=0 => likely PROJECTION_INPUTS_INCOMPLETE gate in model jobs"
echo "- source_mapping_ok=0 or NULL + ingest failures => likely team mapping/enrichment contract issue"
echo "- no recent successful pull_odds_hourly/model runs => scheduler freshness/cadence issue"
