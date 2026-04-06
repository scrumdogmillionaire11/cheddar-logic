---
phase: quick-136
plan: 01
type: execute
wave: 1
depends_on: []
files_modified:
  - .github/workflows/audit.yml
autonomous: true
requirements: [QUICK-136]
must_haves:
  truths:
    - "CI fails with a non-zero exit code when any required audit artifact is missing"
    - "The failure log shows which artifacts are missing and which upstream step was responsible for producing each"
    - "The failure log includes a content preview of any artifacts that were produced so the developer can diagnose without downloading"
  artifacts:
    - path: ".github/workflows/audit.yml"
      provides: "Enhanced 'Ensure audit artifacts exist' step with structured diagnostics"
  key_links:
    - from: "'Run audit gate' step"
      to: "audit-report.json, audit-summary.json"
      via: "run_model_audit.js --output-dir"
      pattern: "audit-report\\.json"
    - from: "'Generate scorecard' step"
      to: "scorecard.json, audit-scorecard.md"
      via: "audit:scorecard npm script"
      pattern: "scorecard\\.json"
---

<objective>
Enhance the "Ensure audit artifacts exist" step in audit.yml so that when required artifacts are missing, the CI failure log includes: which step was responsible for each missing artifact, a content preview of any artifacts that were produced, and a clear diagnostic block rather than a bare list of missing paths.

Purpose: When the audit CI fails, engineers need to diagnose the root cause (did the audit gate crash? did the scorecard step fail silently?) directly from the CI log without downloading the artifact archive.
Output: Updated .github/workflows/audit.yml with an enhanced artifact-guard step.
</objective>

<execution_context>
@/Users/ajcolubiale/.claude/get-shit-done/workflows/execute-plan.md
@/Users/ajcolubiale/.claude/get-shit-done/templates/summary.md
</execution_context>

<context>
@.planning/STATE.md

Relevant prior work: WI-0741 added the current "Ensure audit artifacts exist" step and set `if-no-files-found: error` on the upload step. That hardened the failure mode but did not add diagnostics. This task extends that step only — no changes to audit JS, scorecard JS, or any other workflow step.

Artifact ownership:
- audit-report.json — written by "Run audit gate" step (run_model_audit.js)
- audit-summary.json — written by "Run audit gate" step (run_model_audit.js)
- scorecard.json — written by "Generate scorecard" step (audit:scorecard script)
- audit-scorecard.md — written by "Generate scorecard" step (audit:scorecard script)
</context>

<tasks>

<task type="auto">
  <name>Task 1: Enhance "Ensure audit artifacts exist" step with structured diagnostics</name>
  <files>.github/workflows/audit.yml</files>
  <action>
Replace the body of the "Ensure audit artifacts exist" step (lines 79-94) with a richer diagnostic block. Keep all surrounding steps exactly as-is; only this step's `run:` script changes.

The new script must:

1. Print a labeled header: `=== Audit artifact diagnostic ===`

2. For each of the four required artifacts, print one of two outcomes:
   - PRESENT: print `[OK]  <artifact>` and cat up to 30 lines of the file as a preview (use `head -30`)
   - MISSING: print `[MISSING] <artifact>  (produced by: <step-name>)` where step-name is one of:
     - "Run audit gate" for audit-report.json and audit-summary.json
     - "Generate scorecard" for scorecard.json and audit-scorecard.md

3. After iterating all four artifacts, if any were missing:
   - Print `=== Missing artifact summary ===`
   - Re-list each missing artifact on its own line with the owning step
   - Exit 1

4. If all artifacts present, exit 0.

Use this exact shell structure (bash):

```bash
OUTPUT_DIR="$GITHUB_WORKSPACE/apps/worker/audit-output/${RUN_SCOPE}"
echo "=== Audit artifact diagnostic ==="
echo "Run scope: ${RUN_SCOPE}"
echo "Output dir: ${OUTPUT_DIR}"
echo ""

declare -A ARTIFACT_OWNER=(
  ["audit-report.json"]="Run audit gate"
  ["audit-summary.json"]="Run audit gate"
  ["scorecard.json"]="Generate scorecard"
  ["audit-scorecard.md"]="Generate scorecard"
)

missing_list=()

for artifact in audit-report.json audit-summary.json scorecard.json audit-scorecard.md; do
  artifact_path="$OUTPUT_DIR/$artifact"
  owner="${ARTIFACT_OWNER[$artifact]}"
  if [ -f "$artifact_path" ]; then
    echo "[OK]  $artifact"
    echo "--- preview (head -30) ---"
    head -30 "$artifact_path" || true
    echo "--- end preview ---"
    echo ""
  else
    echo "[MISSING] $artifact  (produced by: $owner)"
    missing_list+=("$artifact (produced by: $owner)")
    echo ""
  fi
done

if [ "${#missing_list[@]}" -gt 0 ]; then
  echo "=== Missing artifact summary ==="
  for entry in "${missing_list[@]}"; do
    echo "  - $entry"
  done
  exit 1
fi
```

Do NOT remove or change the `if: always()` condition on this step. Do NOT change any other step.
  </action>
  <verify>
    <automated>grep -c "ARTIFACT_OWNER" /Users/ajcolubiale/projects/cheddar-logic/.github/workflows/audit.yml</automated>
  </verify>
  <done>
- `ARTIFACT_OWNER` associative array present in audit.yml
- Each of the four artifact names appears in the diagnostic loop with its owning step name
- `exit 1` fires only when missing_list is non-empty
- No other steps in audit.yml were modified (diff shows only the "Ensure audit artifacts exist" run block changed)
  </done>
</task>

</tasks>

<verification>
After editing:
1. `grep -A 60 "Ensure audit artifacts exist" .github/workflows/audit.yml` shows the new diagnostic block
2. `grep "Run audit gate\|Generate scorecard" .github/workflows/audit.yml` returns hits inside the ARTIFACT_OWNER map
3. All other step names in audit.yml are unchanged: "Checkout", "Setup Node", "Install audit dependencies", "Collect changed audit fixtures", "Run audit gate", "Generate scorecard", "Upload audit artifacts"
4. `yamllint .github/workflows/audit.yml` (or `python3 -c "import yaml,sys; yaml.safe_load(open('.github/workflows/audit.yml'))"`) reports no parse errors
</verification>

<success_criteria>
When a required audit artifact is absent, the CI log shows:
- Which artifact is missing
- Which step was responsible for producing it (enabling the developer to jump directly to that step's log)
- A content preview of any artifacts that were successfully produced
- A clear "Missing artifact summary" block before the non-zero exit
</success_criteria>

<output>
After completion, create `.planning/quick/136-fail-ci-with-diagnostics-when-model-audi/136-SUMMARY.md`
</output>
