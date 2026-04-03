#!/bin/bash
set -e

# Free port 3000 if held by an orphan (best-effort, not fatal if nothing to kill)
fuser -k 3000/tcp 2>/dev/null || true

exec node_modules/.bin/next start
