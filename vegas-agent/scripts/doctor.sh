#!/usr/bin/env bash
set -euo pipefail

TARGET="${1:-.}"
FAIL=0

check_file() {
  local p="$1"
  if [[ ! -f "$TARGET/$p" ]]; then
    echo "[FAIL] Missing file: $p"
    FAIL=1
  else
    echo "[OK]   $p"
  fi
}

check_dir() {
  local p="$1"
  if [[ ! -d "$TARGET/$p" ]]; then
    echo "[FAIL] Missing dir: $p"
    FAIL=1
  else
    echo "[OK]   $p"
  fi
}

echo "Running VEGAS doctor for: $TARGET"

check_dir "core"
check_dir "models"
check_dir "workflows"
check_dir "guardrails"
check_dir "prompts"
check_dir ".claude/agents"
check_dir "scripts"
check_dir "tests"

check_file "README.md"
check_file "CHANGELOG.md"
check_file ".claude/agents/vegas-auditor.md"
check_file "prompts/audit_prompt.txt"
check_file "prompts/challenge_prompt.txt"

REQUIRED_MARKDOWN_FILES=(
  "core/principles.md"
  "core/edge_framework.md"
  "core/risk_management.md"
  "core/market_truths.md"
  "models/generic_ev_model.md"
  "models/line_movement.md"
  "models/market_vs_model.md"
  "models/variance_profiles.md"
  "workflows/bet_review.md"
  "workflows/card_validation.md"
  "workflows/model_output_audit.md"
  "guardrails/red_flags.md"
  "guardrails/anti-patterns.md"
  "guardrails/sanity_checks.md"
)

for f in "${REQUIRED_MARKDOWN_FILES[@]}"; do
  check_file "$f"
done

if [[ $FAIL -ne 0 ]]; then
  echo "Doctor result: FAIL"
  exit 1
fi

echo "Doctor result: PASS"
