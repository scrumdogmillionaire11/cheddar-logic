#!/bin/bash
# External watchdog for scheduler availability.
# Intended for cron/systemd timer use so alerts still fire even if scheduler is down.

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SERVICE_NAME="${CHEDDAR_WORKER_SERVICE:-cheddar-worker}"
ENV_FILE="${CHEDDAR_ENV_FILE:-$ROOT_DIR/.env.production}"
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
