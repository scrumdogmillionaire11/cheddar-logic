#!/usr/bin/env bash

set -Eeuo pipefail

TARGET_PATH="${1:-/opt}"
MIN_FREE_KB="${MIN_FREE_KB:-524288}"

echo "[disk-hygiene] Target path: ${TARGET_PATH}"
echo "[disk-hygiene] Minimum free after cleanup: ${MIN_FREE_KB}KB"

AVAIL_KB_BEFORE=$(df "${TARGET_PATH}" --output=avail | tail -1)
echo "[disk-hygiene] Disk available before cleanup: ${AVAIL_KB_BEFORE}KB"

# Remove rollback snapshot from previous deploy (can be 100-300 MB)
rm -rf /tmp/cheddar-prev-next-full || true

# Prune Next.js static archive: keep only 3 most recent snapshots
ARCHIVE_ROOT="/opt/cheddar-logic/.next-static-archive"
if [ -d "${ARCHIVE_ROOT}" ]; then
  ARCHIVE_COUNT=$(find "${ARCHIVE_ROOT}" -mindepth 1 -maxdepth 1 -type d | wc -l)
  if [ "${ARCHIVE_COUNT}" -gt 3 ]; then
    PRUNE=$(( ARCHIVE_COUNT - 3 ))
    find "${ARCHIVE_ROOT}" -mindepth 1 -maxdepth 1 -type d | sort | head -n "${PRUNE}" | xargs rm -rf
    echo "[disk-hygiene] Pruned ${PRUNE} old static archive snapshot(s)"
  fi
fi

# Clear npm cache to reclaim space from partial/failed installs
npm cache clean --force 2>/dev/null || true
rm -rf ~/.npm/_cacache 2>/dev/null || true

# Trim journal and package caches
sudo journalctl --vacuum-size=50M 2>/dev/null || true
sudo apt-get clean 2>/dev/null || true

# Rotate deploy log if too large (5 MB)
DEPLOY_LOG_PATH="/opt/cheddar-logic/logs/deploy.log"
if [ -f "${DEPLOY_LOG_PATH}" ] && [ "$(wc -c < "${DEPLOY_LOG_PATH}")" -gt 5242880 ]; then
  tail -500 "${DEPLOY_LOG_PATH}" > "${DEPLOY_LOG_PATH}.tmp" && mv "${DEPLOY_LOG_PATH}.tmp" "${DEPLOY_LOG_PATH}"
  echo "[disk-hygiene] Rotated deploy.log (trimmed to last 500 lines)"
fi

# Rotate scheduler log if too large (50 MB)
SCHED_LOG_PATH="/opt/cheddar-logic/apps/worker/logs/scheduler.log"
if [ -f "${SCHED_LOG_PATH}" ] && [ "$(wc -c < "${SCHED_LOG_PATH}")" -gt 52428800 ]; then
  tail -2000 "${SCHED_LOG_PATH}" > "${SCHED_LOG_PATH}.tmp" && mv "${SCHED_LOG_PATH}.tmp" "${SCHED_LOG_PATH}"
  echo "[disk-hygiene] Rotated scheduler.log (trimmed to last 2000 lines)"
fi

# Remove stale test database artifacts left in /tmp
find /tmp -maxdepth 1 \( -name "cheddar-test-*.db" -o -name "cheddar-test-*.db.lock" -o -name "cheddar-db-backup-*" \) -mtime +0 -exec rm -rf {} + 2>/dev/null || true

# Clear Python pip cache if present
pip3 cache purge 2>/dev/null || true

AVAIL_KB_AFTER=$(df "${TARGET_PATH}" --output=avail | tail -1)
echo "[disk-hygiene] Disk available after cleanup: ${AVAIL_KB_AFTER}KB"

if [ "${AVAIL_KB_AFTER}" -lt "${MIN_FREE_KB}" ]; then
  echo "ERROR: Less than $(( MIN_FREE_KB / 1024 )) MB free after cleanup (${AVAIL_KB_AFTER}KB)"
  exit 1
fi

echo "[disk-hygiene] OK"