#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

echo "[1/4] Installing packages/data dependencies"
npm --prefix "$ROOT_DIR/packages/data" install

echo "[2/4] Running data migrations"
npm --prefix "$ROOT_DIR/packages/data" run migrate

echo "[3/4] Seeding test odds for UI"
npm --prefix "$ROOT_DIR/packages/data" run seed:test-odds

echo "[4/4] Installing web dependencies and starting Next.js"
npm --prefix "$ROOT_DIR/web" install

PORT="${PORT:-3000}"
echo "Starting UI at http://localhost:${PORT}"
cd "$ROOT_DIR/web"
PORT="$PORT" npm run dev