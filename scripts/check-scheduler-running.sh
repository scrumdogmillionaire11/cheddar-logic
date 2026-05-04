#!/bin/bash
# External watchdog for scheduler availability.
# Intended for cron/systemd timer use so alerts still fire even if scheduler is down.

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SERVICE_NAME="${CHEDDAR_WORKER_SERVICE:-cheddar-worker}"
ENV_FILE="${CHEDDAR_ENV_FILE:-$ROOT_DIR/.env.production}"
HEARTBEAT_FILE="${CHEDDAR_SCHEDULER_HEARTBEAT_FILE:-/opt/data/cheddar-worker-heartbeat.json}"
HEARTBEAT_MAX_AGE_SECONDS="${CHEDDAR_SCHEDULER_HEARTBEAT_MAX_AGE_SECONDS:-420}"
WATCHDOG_AUTO_RESTART="${CHEDDAR_WORKER_WATCHDOG_AUTO_RESTART:-true}"
if [ ! -f "$ENV_FILE" ] && [ -f "$ROOT_DIR/.env" ]; then
  ENV_FILE="$ROOT_DIR/.env"
fi

load_env_file() {
  local file="$1"
  [ -f "$file" ] || return 0
  if ! command -v node >/dev/null 2>&1; then
    return 0
  fi

  local export_script
  export_script=$(mktemp)

  if ! node -e '
    const fs = require("fs");
    const dotenv = require("dotenv");
    const file = process.argv[1];
    const parsed = dotenv.parse(fs.readFileSync(file));
    for (const [key, raw] of Object.entries(parsed)) {
      const value = String(raw)
        .replace(/\\/g, "\\\\")
        .replace(/"/g, "\\\"")
        .replace(/\$/g, "\\$")
        .replace(/`/g, "\\`");
      process.stdout.write(`export ${key}="${value}"\n`);
    }
  ' "$file" > "$export_script"; then
    rm -f "$export_script"
    return 0
  fi

  # shellcheck disable=SC1090
  source "$export_script"
  rm -f "$export_script"
}

load_env_file "$ENV_FILE"

read_heartbeat_age_seconds() {
  local file="$1"
  [ -f "$file" ] || return 2
  if ! command -v node >/dev/null 2>&1; then
    return 3
  fi
  node -e '
    const fs = require("fs");
    const file = process.argv[1];
    const raw = fs.readFileSync(file, "utf8");
    const hb = JSON.parse(raw);
    const stamp =
      hb.updated_at || hb.last_tick_completed_at || hb.last_tick_started_at || null;
    if (!stamp) process.exit(2);
    const thenMs = Date.parse(stamp);
    if (!Number.isFinite(thenMs)) process.exit(3);
    const ageSec = Math.max(0, Math.floor((Date.now() - thenMs) / 1000));
    process.stdout.write(String(ageSec));
  ' "$file"
}

service_active=false
status="unknown"
recent_logs=""

if command -v systemctl >/dev/null 2>&1; then
  if systemctl is-active --quiet "$SERVICE_NAME"; then
    service_active=true
    status="active"
  else
    status="$(systemctl is-active "$SERVICE_NAME" 2>/dev/null || echo unknown)"
  fi
  recent_logs="$(journalctl -u "$SERVICE_NAME" -n 25 --no-pager 2>/dev/null | tail -n 8 || true)"
elif pgrep -f "node.*schedulers/main.js" >/dev/null 2>&1; then
  service_active=true
  status="active-via-pgrep"
else
  status="inactive-no-systemctl"
fi

if [ "$service_active" = true ]; then
  heartbeat_age=""
  if heartbeat_age=$(read_heartbeat_age_seconds "$HEARTBEAT_FILE" 2>/dev/null); then
    if [ "$heartbeat_age" -gt "$HEARTBEAT_MAX_AGE_SECONDS" ]; then
      service_active=false
      status="heartbeat-stale-${heartbeat_age}s"
    else
      status="${status}-heartbeat-ok-${heartbeat_age}s"
    fi
  else
    service_active=false
    status="heartbeat-missing-or-invalid"
  fi
fi

if [ "$service_active" = false ] && [ "$WATCHDOG_AUTO_RESTART" = "true" ] && command -v systemctl >/dev/null 2>&1; then
  echo "[watchdog] attempting restart for $SERVICE_NAME (status=$status)"
  if [ "$(id -u)" -eq 0 ]; then
    RESTART_CMD=(systemctl restart "$SERVICE_NAME")
    ACTIVE_CMD=(systemctl is-active --quiet "$SERVICE_NAME")
  else
    RESTART_CMD=(sudo -n systemctl restart "$SERVICE_NAME")
    ACTIVE_CMD=(sudo -n systemctl is-active --quiet "$SERVICE_NAME")
  fi
  if "${RESTART_CMD[@]}" >/dev/null 2>&1 && "${ACTIVE_CMD[@]}"; then
    echo "[watchdog] restart successful for $SERVICE_NAME"
    exit 0
  fi
fi

if [ "$service_active" = true ]; then
  echo "[watchdog] $SERVICE_NAME active ($status)"
  exit 0
fi

timestamp="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
host="$(hostname)"

message="[scheduler-watchdog] $SERVICE_NAME is NOT running on $host at $timestamp (status=$status)"
echo "$message"

webhook_url="${DISCORD_ALERT_WEBHOOK_URL:-}"
if [ -n "${webhook_url}" ]; then
  payload=$(node -e '
    const message = process.argv[1];
    const logs = process.argv[2];
    const content = `${message}\n\nRecent logs:\n\`\`\`\n${logs || "(no logs)"}\n\`\`\``;
    process.stdout.write(JSON.stringify({ content }));
  ' "$message" "$recent_logs")
  curl -sS -X POST "$webhook_url" \
    -H "Content-Type: application/json" \
    -d "$payload" >/dev/null || true
fi

exit 1
