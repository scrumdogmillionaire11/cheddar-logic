#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo "Usage: $0 /path/to/target-project"
  exit 1
fi

TARGET="$1"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PKG_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

if [[ ! -d "$TARGET/.claude" ]]; then
  echo "Target is not initialized (.claude missing): $TARGET"
  echo "Run install.sh first."
  exit 1
fi

"$PKG_ROOT/scripts/install.sh" "$TARGET"
