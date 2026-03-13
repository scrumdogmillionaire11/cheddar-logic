#!/usr/bin/env bash
set -euo pipefail

DEFAULT_DB_PATH="/opt/data/cheddar-prod.db"
DB_PATH="${CHEDDAR_DB_PATH:-$DEFAULT_DB_PATH}"
GRACE_HOURS=6
LOOKBACK_HOURS=24
STRICT=0
EXPECT_PROD_PATH=1

usage() {
  cat <<'EOF'
Usage: scripts/settlement-health-check.sh [options]

Read-only settlement health checks for a sql.js sqlite DB.
Returns non-zero when critical blockers are detected.

Options:
  --db <path>                DB path (default: $CHEDDAR_DB_PATH or /opt/data/cheddar-prod.db)
  --grace-hours <n>          Hours after game start before "missing final" is considered stale (default: 6)
  --lookback-hours <n>       Hours of job history to inspect (default: 24)
  --strict                   Treat warnings as failures (useful for deployment gates)
  --allow-nonprod-path       Do not warn when DB path is not /opt/data/cheddar-prod.db
  -h, --help                 Show this help

Examples:
  scripts/settlement-health-check.sh
  scripts/settlement-health-check.sh --db /opt/data/cheddar-prod.db --strict
  scripts/settlement-health-check.sh --db /tmp/cheddar-logic/cheddar.db --grace-hours 4
EOF
}

is_integer() {
  [[ "${1:-}" =~ ^[0-9]+$ ]]
}

run_scalar() {
  local sql="$1"
  local value
  value="$(sqlite3 -noheader -batch "$DB_PATH" "$sql" | tr -d '\r' | head -n 1)"
  if [[ -z "$value" ]]; then
    echo "0"
    return
  fi
  echo "$value"
}

print_table() {
  local title="$1"
  local sql="$2"
  echo
  echo "$title"
  sqlite3 -header -column "$DB_PATH" "$sql"
}

declare -a FAIL_MESSAGES=()
declare -a WARN_MESSAGES=()

add_fail() {
  FAIL_MESSAGES+=("$1")
}

add_warn() {
  WARN_MESSAGES+=("$1")
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --db)
      DB_PATH="${2:-}"
      shift 2
      ;;
    --grace-hours)
      GRACE_HOURS="${2:-}"
      shift 2
      ;;
    --lookback-hours)
      LOOKBACK_HOURS="${2:-}"
      shift 2
      ;;
    --strict)
      STRICT=1
      shift
      ;;
    --allow-nonprod-path)
      EXPECT_PROD_PATH=0
      shift
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

if ! is_integer "$GRACE_HOURS"; then
  echo "--grace-hours must be a non-negative integer" >&2
  exit 2
fi

if ! is_integer "$LOOKBACK_HOURS"; then
  echo "--lookback-hours must be a non-negative integer" >&2
  exit 2
fi

if [[ -z "$DB_PATH" ]]; then
  echo "DB path is empty. Pass --db or set CHEDDAR_DB_PATH." >&2
  exit 2
fi

if ! command -v sqlite3 >/dev/null 2>&1; then
  echo "sqlite3 is required but not installed." >&2
  exit 2
fi

if [[ ! -f "$DB_PATH" ]]; then
  echo "DB file not found: $DB_PATH" >&2
  exit 2
fi

if ! sqlite3 "$DB_PATH" "SELECT 1;" >/dev/null 2>&1; then
  echo "Unable to read sqlite DB: $DB_PATH" >&2
  exit 2
fi

if [[ "$EXPECT_PROD_PATH" -eq 1 && "$DB_PATH" != "$DEFAULT_DB_PATH" ]]; then
  add_warn "DB path is '$DB_PATH' (expected '$DEFAULT_DB_PATH' for production)."
fi

LOCK_FILE="${DB_PATH}.lock"
if [[ ! -f "$LOCK_FILE" ]]; then
  add_warn "DB lock file not found ($LOCK_FILE). If worker should be active, verify service state."
fi

STALE_CUTOFF_EXPR="datetime('now', '-${GRACE_HOURS} hours')"
LOOKBACK_EXPR="datetime('now', '-${LOOKBACK_HOURS} hours')"

total_pending="$(run_scalar "SELECT COUNT(*) FROM card_results WHERE status='pending';")"
eligible_pending_final_displayed="$(run_scalar "
  SELECT COUNT(*)
  FROM card_results cr
  INNER JOIN card_display_log cdl ON cdl.pick_id = cr.card_id
  INNER JOIN game_results gr ON gr.game_id = cr.game_id
  WHERE cr.status = 'pending'
    AND cr.market_key IS NOT NULL
    AND gr.status = 'final';
")"
pending_with_final_no_display="$(run_scalar "
  SELECT COUNT(*)
  FROM card_results cr
  INNER JOIN game_results gr ON gr.game_id = cr.game_id
  LEFT JOIN card_display_log cdl ON cdl.pick_id = cr.card_id
  WHERE cr.status = 'pending'
    AND cr.market_key IS NOT NULL
    AND gr.status = 'final'
    AND cdl.pick_id IS NULL;
")"
pending_with_final_missing_market_key="$(run_scalar "
  SELECT COUNT(*)
  FROM card_results cr
  INNER JOIN game_results gr ON gr.game_id = cr.game_id
  WHERE cr.status = 'pending'
    AND cr.market_key IS NULL
    AND gr.status = 'final';
")"
final_displayed_missing_results="$(run_scalar "
  SELECT COUNT(*)
  FROM card_display_log cdl
  LEFT JOIN card_results cr ON cr.card_id = cdl.pick_id
  INNER JOIN game_results gr ON gr.game_id = cdl.game_id
  WHERE cr.id IS NULL
    AND gr.status = 'final';
")"
stale_games_without_final="$(run_scalar "
  SELECT COUNT(*)
  FROM games g
  LEFT JOIN game_results gr ON gr.game_id = g.game_id AND gr.status = 'final'
  WHERE g.game_time_utc <= ${STALE_CUTOFF_EXPR}
    AND gr.game_id IS NULL;
")"
pending_cards_on_stale_games="$(run_scalar "
  SELECT COUNT(*)
  FROM card_results cr
  INNER JOIN games g ON g.game_id = cr.game_id
  LEFT JOIN game_results gr ON gr.game_id = cr.game_id AND gr.status = 'final'
  WHERE cr.status = 'pending'
    AND g.game_time_utc <= ${STALE_CUTOFF_EXPR}
    AND gr.game_id IS NULL;
")"
non_actionable_final_pending_stale="$(run_scalar "
  SELECT COUNT(*)
  FROM card_results cr
  INNER JOIN games g ON g.game_id = cr.game_id
  INNER JOIN game_results gr ON gr.game_id = cr.game_id
  LEFT JOIN card_payloads cp ON cp.id = cr.card_id
  WHERE cr.status = 'pending'
    AND gr.status = 'final'
    AND g.game_time_utc <= ${STALE_CUTOFF_EXPR}
    AND (
      CASE
        WHEN json_valid(cp.payload_data)
        THEN UPPER(COALESCE(json_extract(cp.payload_data, '$.kind'), 'PLAY'))
        ELSE 'PLAY'
      END != 'PLAY'
      OR
      CASE
        WHEN json_valid(cp.payload_data)
        THEN UPPER(COALESCE(
          json_extract(cp.payload_data, '$.decision_v2.official_status'),
          json_extract(cp.payload_data, '$.status'),
          ''
        ))
        ELSE ''
      END = 'PASS'
    );
")"
recent_failed_settlement_jobs="$(run_scalar "
  SELECT COUNT(*)
  FROM job_runs
  WHERE job_name IN ('settle_game_results', 'settle_pending_cards')
    AND status = 'failed'
    AND started_at >= ${LOOKBACK_EXPR};
")"
recent_non_actionable_auto_closed="$(run_scalar "
  SELECT COUNT(*)
  FROM card_results cr
  WHERE cr.status = 'error'
    AND cr.result = 'void'
    AND cr.settled_at >= ${LOOKBACK_EXPR}
    AND CASE
      WHEN json_valid(cr.metadata)
      THEN COALESCE(json_extract(cr.metadata, '$.settlement_error.classification'), '')
      ELSE ''
    END = 'NON_ACTIONABLE_AUTO_CLOSE';
")"

if (( eligible_pending_final_displayed > 0 )); then
  add_fail "Actionable pending cards already have final results (${eligible_pending_final_displayed}). Settlement is behind."
fi
if (( stale_games_without_final > 0 )); then
  add_fail "Games older than ${GRACE_HOURS}h are still missing final scores (${stale_games_without_final})."
fi
if (( pending_cards_on_stale_games > 0 )); then
  add_fail "Pending cards are attached to stale games with no final result (${pending_cards_on_stale_games})."
fi
if (( non_actionable_final_pending_stale > 0 )); then
  add_fail "Non-actionable final pending cards remain past grace window (${non_actionable_final_pending_stale})."
fi

if (( pending_with_final_no_display > 0 )); then
  add_warn "Pending+final cards missing display-log rows (${pending_with_final_no_display}). Check backfill/ledger coverage."
fi
if (( pending_with_final_missing_market_key > 0 )); then
  add_warn "Pending+final cards missing market_key (${pending_with_final_missing_market_key})."
fi
if (( final_displayed_missing_results > 0 )); then
  add_warn "Displayed final picks missing card_results rows (${final_displayed_missing_results})."
fi
if (( recent_failed_settlement_jobs > 0 )); then
  add_warn "Settlement job failures in last ${LOOKBACK_HOURS}h (${recent_failed_settlement_jobs})."
fi

echo "Settlement Health Report"
echo "  DB: $DB_PATH"
echo "  Grace window: ${GRACE_HOURS}h"
echo "  Job lookback: ${LOOKBACK_HOURS}h"
echo
printf '  %-42s %s\n' "total_pending_cards" "$total_pending"
printf '  %-42s %s\n' "eligible_pending_final_displayed" "$eligible_pending_final_displayed"
printf '  %-42s %s\n' "pending_with_final_no_display" "$pending_with_final_no_display"
printf '  %-42s %s\n' "pending_with_final_missing_market_key" "$pending_with_final_missing_market_key"
printf '  %-42s %s\n' "final_displayed_missing_results" "$final_displayed_missing_results"
printf '  %-42s %s\n' "stale_games_without_final" "$stale_games_without_final"
printf '  %-42s %s\n' "pending_cards_on_stale_games" "$pending_cards_on_stale_games"
printf '  %-42s %s\n' "non_actionable_final_pending_stale" "$non_actionable_final_pending_stale"
printf '  %-42s %s\n' "recent_failed_settlement_jobs" "$recent_failed_settlement_jobs"
printf '  %-42s %s\n' "recent_non_actionable_auto_closed" "$recent_non_actionable_auto_closed"

print_table "Pending actionable final cards by sport (must be 0)" "
  SELECT UPPER(cr.sport) AS sport, COUNT(*) AS pending_actionable_final
  FROM card_results cr
  INNER JOIN card_display_log cdl ON cdl.pick_id = cr.card_id
  INNER JOIN game_results gr ON gr.game_id = cr.game_id
  WHERE cr.status = 'pending'
    AND cr.market_key IS NOT NULL
    AND gr.status = 'final'
  GROUP BY 1
  ORDER BY 2 DESC;
"

print_table "Stale games without final result by sport (> grace window)" "
  SELECT UPPER(g.sport) AS sport, COUNT(*) AS stale_games_without_final
  FROM games g
  LEFT JOIN game_results gr ON gr.game_id = g.game_id AND gr.status = 'final'
  WHERE g.game_time_utc <= ${STALE_CUTOFF_EXPR}
    AND gr.game_id IS NULL
  GROUP BY 1
  ORDER BY 2 DESC;
"

print_table "Recent settlement job runs" "
  SELECT job_name, status, started_at, ended_at,
         substr(COALESCE(error_message, ''), 1, 120) AS error
  FROM job_runs
  WHERE job_name IN ('settle_game_results', 'settle_pending_cards')
    AND started_at >= ${LOOKBACK_EXPR}
  ORDER BY started_at DESC
  LIMIT 20;
"

if (( ${#FAIL_MESSAGES[@]} > 0 )); then
  echo
  echo "Critical findings:"
  for msg in "${FAIL_MESSAGES[@]}"; do
    echo "  - $msg"
  done
fi

if (( ${#WARN_MESSAGES[@]} > 0 )); then
  echo
  echo "Warnings:"
  for msg in "${WARN_MESSAGES[@]}"; do
    echo "  - $msg"
  done
fi

if (( STRICT == 1 && ${#WARN_MESSAGES[@]} > 0 )); then
  echo
  echo "Strict mode enabled: warnings are treated as failures."
  exit 1
fi

if (( ${#FAIL_MESSAGES[@]} > 0 )); then
  exit 1
fi

echo
echo "Settlement health check passed."
