#!/bin/bash
# restart-cloudflared-when-ready.sh
#
# Waits for Next.js to be ready on port 3000, then restarts cloudflared.
#
# WHY THIS EXISTS:
#   ExecStartPost fires at process fork time (Type=simple), not when Next.js
#   has finished cold-starting and is actually listening on port 3000.
#   Restarting cloudflared before the origin is ready means the tunnel is live
#   but connections to 127.0.0.1:3000 are refused → Cloudflare returns 502.
#
#   This script polls until curl succeeds (or times out), then restarts
#   cloudflared so it picks up a fresh connection to the ready origin.
#
# USAGE (via cheddar-web.service ExecStartPost):
#   ExecStartPost=+/opt/cheddar-logic/deploy/restart-cloudflared-when-ready.sh
#
# The + prefix runs as root (required to call systemctl restart cloudflared).

set -euo pipefail

ORIGIN="http://127.0.0.1:3000"
MAX_WAIT_SECONDS=60
POLL_INTERVAL_SECONDS=2

echo "[restart-cloudflared-when-ready] Waiting for Next.js to be ready at ${ORIGIN}..."

elapsed=0
while [ "$elapsed" -lt "$MAX_WAIT_SECONDS" ]; do
  http_code=$(curl -s -o /dev/null -w "%{http_code}" --max-time 2 "${ORIGIN}" 2>/dev/null || true)
  if [ "$http_code" = "200" ] || [ "$http_code" = "301" ] || [ "$http_code" = "302" ] || [ "$http_code" = "307" ] || [ "$http_code" = "308" ]; then
    echo "[restart-cloudflared-when-ready] Next.js ready (HTTP ${http_code}) after ${elapsed}s. Restarting cloudflared..."
    /bin/systemctl restart cloudflared
    echo "[restart-cloudflared-when-ready] cloudflared restarted successfully."
    exit 0
  fi
  sleep "$POLL_INTERVAL_SECONDS"
  elapsed=$(( elapsed + POLL_INTERVAL_SECONDS ))
done

echo "[restart-cloudflared-when-ready] WARNING: Next.js did not become ready within ${MAX_WAIT_SECONDS}s. Restarting cloudflared anyway to avoid stale connections."
/bin/systemctl restart cloudflared || true
exit 0
