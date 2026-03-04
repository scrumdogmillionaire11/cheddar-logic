#!/usr/bin/env bash
# Consolidate to one canonical record database for web + worker.
# Dry-run by default. Use --apply to make changes.
#
# Typical usage on prod host:
#   ./scripts/consolidate-record-db.sh --auto-source
#   sudo ./scripts/consolidate-record-db.sh --auto-source --apply --restart

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
PROD_ROOT="/opt/cheddar-logic"
if [ ! -d "$PROD_ROOT" ]; then
  PROD_ROOT="$REPO_ROOT"
fi

CANONICAL_DB="/opt/data/cheddar.db"
SOURCE_DB=""
AUTO_SOURCE=false
APPLY=false
RESTART=false
DISABLE_STRAY_ENV=true

if ! command -v sqlite3 >/dev/null 2>&1; then
  echo "ERROR: sqlite3 is required for DB inspection."
  exit 1
fi

usage() {
  cat <<EOF
Usage: $0 [options]

Options:
  --canonical <path>   Canonical DB path (default: /opt/data/cheddar.db)
  --source <path>      Explicit source DB to promote
  --auto-source        Choose source DB with highest data score
  --apply              Apply changes (default: dry-run)
  --restart            Restart cheddar-web and cheddar-worker (implies --apply)
  --keep-env-files     Do not disable stray .env/.env.local files
  -h, --help           Show this help

Examples:
  $0 --auto-source
  sudo $0 --auto-source --apply --restart
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --canonical)
      CANONICAL_DB="${2:-}"
      shift 2
      ;;
    --source)
      SOURCE_DB="${2:-}"
      shift 2
      ;;
    --auto-source)
      AUTO_SOURCE=true
      shift
      ;;
    --apply)
      APPLY=true
      shift
      ;;
    --restart)
      RESTART=true
      APPLY=true
      shift
      ;;
    --keep-env-files)
      DISABLE_STRAY_ENV=false
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $1"
      usage
      exit 1
      ;;
  esac
done

run_root() {
  if [ "$(id -u)" -eq 0 ]; then
    "$@"
  else
    sudo "$@"
  fi
}

timestamp() {
  date -u +"%Y-%m-%dT%H-%M-%SZ"
}

db_stats_csv() {
  local db="$1"
  sqlite3 "$db" "
    SELECT
      (SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='games'),
      (SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='odds_snapshots'),
      (SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='card_payloads'),
      COALESCE((SELECT COUNT(*) FROM games), 0),
      COALESCE((SELECT COUNT(*) FROM odds_snapshots), 0),
      COALESCE((SELECT COUNT(*) FROM card_payloads), 0),
      COALESCE((SELECT COUNT(*) FROM job_runs WHERE job_name='pull_odds_hourly' AND status='success'), 0),
      COALESCE((SELECT MAX(started_at) FROM job_runs WHERE job_name='pull_odds_hourly' AND status='success'), '');
  " 2>/dev/null || echo "0|0|0|0|0|0|0|"
}

db_score() {
  local games_rows="$1"
  local odds_rows="$2"
  local cards_rows="$3"
  # Heavily prefer real record tables; odds/cfg split keeps ordering deterministic.
  echo $(( games_rows * 1000000 + cards_rows * 10000 + odds_rows * 10 ))
}

declare -a CANDIDATES=()
declare -a UNIQUE=()
declare -a STATS_ROWS=()

add_candidate() {
  local p="$1"
  [ -n "$p" ] || return 0
  [ -f "$p" ] || return 0
  CANDIDATES+=("$p")
}

for dir in \
  "$(dirname "$CANONICAL_DB")" \
  "$PROD_ROOT/packages/data" \
  "$PROD_ROOT/packages/data/backups" \
  "/opt/data" \
  "/opt/data/backups" \
  "/tmp/cheddar-logic" \
  "/tmp/cheddar-logic/backups"
do
  [ -d "$dir" ] || continue
  while IFS= read -r dbf; do
    add_candidate "$dbf"
  done < <(find "$dir" -maxdepth 1 -type f -name "*.db" 2>/dev/null | sort)
done

# Deduplicate candidates.
for db in "${CANDIDATES[@]}"; do
  seen=false
  for u in "${UNIQUE[@]}"; do
    if [ "$u" = "$db" ]; then
      seen=true
      break
    fi
  done
  $seen || UNIQUE+=("$db")
done

echo "=== Record DB Candidates ==="
printf "%-3s %-6s %-6s %-6s %-8s %-8s %-8s %-8s %-20s %s\n" \
  "#" "gTbl" "oTbl" "cTbl" "games" "odds" "cards" "pullOK" "lastPull" "path"
echo "--------------------------------------------------------------------------------------------"

BEST_SCORE=-1
BEST_DB=""
index=0
for db in "${UNIQUE[@]}"; do
  IFS='|' read -r gt ot ct gr orr cr pr lp <<<"$(db_stats_csv "$db")"
  score="$(db_score "$gr" "$orr" "$cr")"
  STATS_ROWS+=("$db|$gt|$ot|$ct|$gr|$orr|$cr|$pr|$lp|$score")
  printf "%-3s %-6s %-6s %-6s %-8s %-8s %-8s %-8s %-20s %s\n" \
    "$index" "$gt" "$ot" "$ct" "$gr" "$orr" "$cr" "$pr" "${lp:-none}" "$db"
  if [ "$score" -gt "$BEST_SCORE" ]; then
    BEST_SCORE="$score"
    BEST_DB="$db"
  fi
  index=$((index + 1))
done

if [ "${#UNIQUE[@]}" -eq 0 ]; then
  echo "No DB candidates found."
  exit 1
fi

if [ -z "$SOURCE_DB" ] && $AUTO_SOURCE; then
  SOURCE_DB="$BEST_DB"
fi

echo
echo "Canonical DB target: $CANONICAL_DB"
echo "Best candidate by data score: $BEST_DB"
if [ -n "$SOURCE_DB" ]; then
  echo "Selected source DB: $SOURCE_DB"
fi

if ! $APPLY; then
  echo
  echo "Dry-run only. Re-run with --apply to perform consolidation."
  exit 0
fi

if [ -z "$SOURCE_DB" ]; then
  echo "ERROR: No source DB selected. Use --source <path> or --auto-source."
  exit 1
fi

if [ ! -f "$SOURCE_DB" ]; then
  echo "ERROR: Source DB does not exist: $SOURCE_DB"
  exit 1
fi

echo
echo "=== Applying Consolidation ==="
run_root mkdir -p "$(dirname "$CANONICAL_DB")"

ts="$(timestamp)"
if [ -f "$CANONICAL_DB" ]; then
  backup_dir="$(dirname "$CANONICAL_DB")/backups"
  backup_file="$backup_dir/cheddar-before-consolidate-$ts.db"
  run_root mkdir -p "$backup_dir"
  run_root cp "$CANONICAL_DB" "$backup_file"
  echo "Backed up canonical DB to: $backup_file"
fi

if [ "$SOURCE_DB" != "$CANONICAL_DB" ]; then
  run_root cp "$SOURCE_DB" "$CANONICAL_DB"
  echo "Promoted source DB to canonical path."
else
  echo "Source DB already equals canonical path."
fi

# Best effort ownership alignment.
if id babycheeses11 >/dev/null 2>&1; then
  run_root chown babycheeses11:babycheeses11 "$CANONICAL_DB"
fi

ENV_FILE="$PROD_ROOT/.env.production"
if [ ! -f "$ENV_FILE" ]; then
  run_root touch "$ENV_FILE"
fi

upsert_env() {
  local key="$1"
  local value="$2"
  local file="$3"
  if run_root grep -q "^${key}=" "$file"; then
    run_root sed -i "s|^${key}=.*|${key}=${value}|" "$file"
  else
    echo "${key}=${value}" | run_root tee -a "$file" >/dev/null
  fi
}

data_dir="$(dirname "$CANONICAL_DB")"
db_url="sqlite:////${CANONICAL_DB#/}"

upsert_env "RECORD_DATABASE_PATH" "$CANONICAL_DB" "$ENV_FILE"
upsert_env "CHEDDAR_DB_PATH" "$CANONICAL_DB" "$ENV_FILE"
upsert_env "DATABASE_PATH" "$CANONICAL_DB" "$ENV_FILE"
upsert_env "DATABASE_URL" "$db_url" "$ENV_FILE"
upsert_env "CHEDDAR_DATA_DIR" "$data_dir" "$ENV_FILE"
upsert_env "CHEDDAR_DB_AUTODISCOVER" "false" "$ENV_FILE"
echo "Updated env contract in $ENV_FILE"

# Systemd overrides enforce single-path runtime env.
for unit in cheddar-web cheddar-worker; do
  dropin_dir="/etc/systemd/system/${unit}.service.d"
  run_root mkdir -p "$dropin_dir"
  cat <<EOF | run_root tee "$dropin_dir/10-record-db.conf" >/dev/null
[Service]
Environment="RECORD_DATABASE_PATH=$CANONICAL_DB"
Environment="CHEDDAR_DB_PATH=$CANONICAL_DB"
Environment="DATABASE_PATH=$CANONICAL_DB"
Environment="DATABASE_URL=$db_url"
Environment="CHEDDAR_DATA_DIR=$data_dir"
Environment="CHEDDAR_DB_AUTODISCOVER=false"
EOF
done
echo "Wrote systemd drop-ins for cheddar-web/cheddar-worker"

if $DISABLE_STRAY_ENV; then
  for f in "$PROD_ROOT/.env" "$PROD_ROOT/.env.local" "$PROD_ROOT/web/.env.local"; do
    if [ -f "$f" ]; then
      run_root mv "$f" "${f}.disabled.$ts"
      echo "Disabled stray env file: $f"
    fi
  done
fi

run_root systemctl daemon-reload
if $RESTART; then
  run_root systemctl restart cheddar-worker cheddar-web
  echo "Restarted cheddar-worker and cheddar-web"
fi

echo
echo "=== Post-Apply Verification ==="
echo "Canonical DB stats:"
sqlite3 "$CANONICAL_DB" "
  SELECT 'games', COUNT(*) FROM games
  UNION ALL
  SELECT 'odds_snapshots', COUNT(*) FROM odds_snapshots
  UNION ALL
  SELECT 'card_payloads', COUNT(*) FROM card_payloads
  UNION ALL
  SELECT 'pull_odds_success', COUNT(*) FROM job_runs WHERE job_name='pull_odds_hourly' AND status='success';
" 2>/dev/null || true

if $RESTART; then
  echo
  echo "API snapshot:"
  for p in "games" "cards?limit=5" "results?limit=20"; do
    echo "---- /api/$p ----"
    curl -sS -w "\nHTTP %{http_code}\n\n" "http://127.0.0.1:3000/api/$p" || true
  done
fi

echo "Done."
