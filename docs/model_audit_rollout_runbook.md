# Model Audit Rollout Runbook

**Audience:** Operators who run, interpret, and action the model audit system.  
**Scope:** The audit stack lives in `apps/worker/src/audit/`. This runbook covers the six operational areas below. It does not cover editing audit tooling or fixtures — those require a work item.

---

## 1. Running the Audit Locally

### Full suite (all sports, all families)

```bash
cd /path/to/cheddar-logic
npm --prefix apps/worker run audit:all
```

Exits `0` if all fixtures pass. Exits `1` if any fixture has `failed > 0` or `gate_failure_count > 0`.

### Per-sport

```bash
npm --prefix apps/worker run audit:nba
npm --prefix apps/worker run audit:nhl
npm --prefix apps/worker run audit:mlb
```

Each loads fixtures for that sport only and produces a local report.

### Scorecard (weekly model review)

```bash
npm --prefix apps/worker run audit:scorecard
```

Generates the weekly scorecard from accumulated audit data. This is what drives the WI-0731 review cycle. Run this after `audit:all` completes cleanly.

### Performance drift report (separate from audit pass/fail)

```bash
npm --prefix apps/worker run audit:performance
```

Runs the performance drift analysis. This is a read-only diagnostic — it does not affect the CI gate. Read it alongside the scorecard. See Section 5 for how to act on its output.

### Writing JSON output artifacts

Append `--out <dir>` to any `run_model_audit.js` invocation to write `report.json` and `summary.json` to the specified directory. The CI configuration uses this flag automatically.

---

## 2. Approving a Baseline

A baseline approval is required when a fixture's `expected.input_hash` is `RECOMPUTE_ON_FIRST_RUN` **and** the fixture file path is listed as changed in the CI changed-files manifest. Without approval the audit gate raises `BASELINE_REVIEW_REQUIRED` (severity HIGH, blocking).

### Step-by-step

**1. Run the audit and read the diff.**

```bash
npm --prefix apps/worker run audit:all
```

Identify every fixture with `drift_type: BASELINE_REVIEW_REQUIRED`. For each one, open the fixture JSON (`apps/worker/src/audit/fixtures/<sport>/<file>.json`) and read the `expected` block alongside the actual snapshot output.

**2. Verify the change is intentional.**

Compare old expected values to new snapshot values. Apply the decay-vs-drift rubric in Section 4 to determine whether the change is a legitimate code change or an unintended regression. Do not approve a baseline that looks like an unintended regression.

**3. Set `baseline_reviewed: true` in the fixture.**

```json
{
  "fixture_id": "...",
  "baseline_reviewed": true,
  "expected": { ... }
}
```

This field tells the gate that a human has reviewed the new expected values.

**4. Add `_baseline_change_note` to the fixture.**

```json
{
  "_baseline_change_note": {
    "changed_by": "WI-####",
    "reason": "One clear sentence explaining why this baseline changed.",
    "approved_at": "2026-04-02",
    "expires_after_runs": 3
  }
}
```

Field rules:
- `changed_by` — the WI number that caused the change, or your name if manual.
- `reason` — must be specific. "Approved" is not acceptable. Cite what changed and why it is correct.
- `approved_at` — ISO 8601 date of the approval.
- `expires_after_runs` — how many weekly audit cycles the note stays valid before it becomes stale. Default is `3` (three weeks). After expiry the gate raises `BASELINE_NOTE_EXPIRED`. Clear or renew before that happens.

**5. Run `audit:all` again and confirm it passes.**

**6. Commit the fixture change.**

```
fix(audit): approve baseline for <fixture_id> — <one-line reason>
```

Do not batch multiple independent fixture approvals into a single commit. One fixture, one commit.

---

## 3. Quarantining a Card Family

Quarantine removes a card family from production execution. Use it when you have confirmed a data corruption, model correctness issue, or unresolvable odds pipeline failure that makes the family's cards unreliable.

The family registry is the gate: **`apps/worker/src/audit/card-family-registry.json`**.

### Step-by-step

**1. Open the registry.**

```
apps/worker/src/audit/card-family-registry.json
```

**2. Find the entry for the family and update these fields:**

```json
{
  "family": "NBA_TOTAL",
  "card_family_status": "QUARANTINED",
  "odds_backed": false,
  "executable": false,
  "status_set_date": "<today ISO 8601>",
  "status_rationale": "Cite the specific issue and the WI tracking remediation."
}
```

Rules:
- `odds_backed` must be `false` for `QUARANTINED`.
- `executable` must be `false` for `QUARANTINED`.
- `status_rationale` must name the specific issue and reference the tracking WI. "Unknown" or "needs investigation" are not acceptable — open a WI first, then quarantine.
- Never silently overwrite `status_set_date` without also updating `status_rationale`.

**3. Commit the registry change.**

```
fix(audit): quarantine <FAMILY> — <one-line reason>
```

**4. Create or update a work item** that tracks the remediation path and defines the acceptance criteria for promotion back to `LIVE` or `PROJECTION_ONLY`.

**5. To lift a quarantine**, promote the family to `PROJECTION_ONLY` (if no live odds lane) or `LIVE` (if the odds lane is confirmed and tested). Follow the promotion steps in `apps/worker/src/audit/README.md`.

---

## 4. Model Decay vs Code Drift — Decision Rubric

When an audit fixture fails or a baseline needs review, you need to determine root cause before acting. Misclassifying code drift as decay (or vice versa) leads to wrong actions.

### Diagnostic questions

Ask these in order:

| # | Question | If YES |
|---|----------|--------|
| 1 | Did the code that produces this output change in this PR/WI? | Likely **code drift** |
| 2 | Did any upstream data schema or field name change? | Likely **code drift** |
| 3 | Did model weights, coefficients, or calibration files change? | Likely **model decay** |
| 4 | Are multiple unrelated fixtures failing simultaneously? | Likely **code drift** (systemic) |
| 5 | Is only one family affected, with no code changes to that family? | Likely **model decay** |
| 6 | Does the output direction match the expected drift from the code change you made? | Confirms **code drift** |

### Code drift

**Definition:** The audit fixture expected values no longer match because the code that produces them was intentionally or unintentionally changed.

**Indicators:**
- `drift_type: SPEC_DRIFT` — field shape or structural invariant mismatch
- Audit failed after a PR that touched model, enrichment, or publish code
- Multiple fixtures across the same sport fail in the same way

**Action:**
- If the change is intentional: update the fixture baselines (Section 2) and document what changed and why.
- If the change is unintended: revert the code change or fix the regression. Do not approve a baseline that hides a broken output.

### Model decay

**Definition:** The audit fixture expected values no longer match because the model's outputs have drifted from their calibrated baseline without a code change.

**Indicators:**
- `drift_type: DECISION_DRIFT` — decision or confidence outputs shifted
- No code changes to the family's model pipeline in recent history
- Only one family is affected
- Performance drift report shows `PASS_RATE_COLLAPSE` or `CALIBRATION_DIVERGENCE` for the same family

**Action:**
- Do **not** approve a new baseline as if this is normal. Investigate why the model is producing different outputs on the same input fixtures.
- Check whether input data has changed upstream (data pipeline drift masquerading as model decay).
- If decay is confirmed: quarantine the family (Section 3) and open a WI to retrain or recalibrate before re-promoting.

### Summary rubric

| Signal | Classification | Approve baseline? | Quarantine? |
|--------|---------------|------------------|-------------|
| Code changed, outputs match new expectation | Code drift (intentional) | YES — document in `_baseline_change_note` | NO |
| Code changed, outputs look broken | Code drift (regression) | NO — fix the code first | Only if output is in production |
| No code changed, outputs shifted on strict fields | Model decay | NO | Evaluate severity — quarantine if `executable: true` |
| No code changed, minor numeric drift within tolerance | Normal variance | N/A — audit tolerance handles this | NO |
| Multiple families fail simultaneously | Systemic code or data issue | NO — investigate root cause first | Only affected families if in production |

**When you are unsure:** do not approve a baseline. Open a WI, describe what you see, and let a second reviewer confirm before touching the fixture.

---

## 5. When Audit Passes but Performance Is Collapsing

The audit gate checks structural correctness against fixed golden fixtures. It can pass cleanly while real-world model performance is deteriorating. The performance drift report (`audit:performance`) is the signal for this condition.

### Alert types from the performance drift report

| Alert | Threshold | Meaning |
|-------|-----------|---------|
| `PASS_RATE_COLLAPSE` | pass rate < 20% | Model is passing far fewer plays than baseline — possible severe calibration failure |
| `EXECUTABLE_RATE_SPIKE` | executable rate > 60% | Model is marking far more plays as executable than expected — possible over-confidence or missing gate logic |
| `CALIBRATION_DIVERGENCE` | divergence > 15% | Predicted probabilities are systematically off from observed outcomes |
| `BLOCK_RATE_SHIFT` | shift > 10% | Block rate has shifted significantly — cards are being blocked or unblocked at an abnormal rate |

### Escalation path

**Step 1: Run both scripts.**

```bash
npm --prefix apps/worker run audit:all
npm --prefix apps/worker run audit:performance
npm --prefix apps/worker run audit:scorecard
```

**Step 2: Identify which families have alerts.**

The performance drift report groups alerts by family and severity. `CRITICAL` alerts require immediate action. `HIGH` alerts require same-day triage. `WARN` alerts require review at the next weekly scorecard.

**Step 3: Correlate with the audit result.**

- Audit pass + performance alert → the golden fixtures do not cover the degradation scenario. This is a gap in the fixture library. Open a WI to add a fixture that exposes the failure mode before taking any other action.
- Audit fail + performance alert → the audit is already catching the problem. Fix the underlying issue (Section 4), do not just approve the baseline.

**Step 4: Act based on severity.**

| Severity | Action |
|----------|--------|
| `CRITICAL` alert on a `LIVE` family | Quarantine the family immediately (Section 3). Open a WI. Do not wait for weekly scorecard. |
| `CRITICAL` alert on a `PROJECTION_ONLY` family | Open a WI. No quarantine needed (cards are not executable by definition). |
| `HIGH` alert on a `LIVE` family | Quarantine if the alert is a `PASS_RATE_COLLAPSE` or `CALIBRATION_DIVERGENCE`. Investigate same-day for `EXECUTABLE_RATE_SPIKE` or `BLOCK_RATE_SHIFT`. |
| `WARN` alert (any family) | Log at the next weekly scorecard review (WI-0731 cycle). No immediate action required. |

**Step 5: Do not promote performance fixes by silently updating fixture baselines.**

If performance was degraded and you fix it, the audit fixture baselines should change because your fix changed the outputs — that is code drift (intentional). Document what changed and why in `_baseline_change_note`.

---

## 6. CI Enforcement

### What is blocking

The CI gate exits `1` (blocking) when `report.failed > 0` or `report.gate_failure_count > 0`. The following conditions cause a blocking failure:

| Condition | `drift_type` | Severity |
|-----------|-------------|----------|
| A fixture's expected hash is `RECOMPUTE_ON_FIRST_RUN` and the fixture file changed, but `baseline_reviewed` is not `true` | `BASELINE_REVIEW_REQUIRED` | HIGH |
| A `_baseline_change_note` has been present for more weekly cycles than its `expires_after_runs` value | `BASELINE_NOTE_EXPIRED` | HIGH |
| Any diff on a strict field (e.g., `execution_status`, `selection_signature`, `reason_codes`, `publish_ready`) in a LIVE family fixture | `SPEC_DRIFT` or `DECISION_DRIFT` | HIGH or CRITICAL |
| Invariant violations on audit output structure | invariant violation | varies |

### What is non-blocking (warns only)

- Numeric field diffs within the tolerances defined in `apps/worker/src/audit/audit_rules_config.js` (e.g., `confidence` within ±0.03, `edge` within ±0.005)
- `WARN`-severity diffs in non-strict fields
- Performance drift alerts (these come from `audit:performance`, which does not exit `1`)

### CI bypass: what it requires

**There is no environment flag to bypass the gate.** The gate is `process.exit(shouldFailGate(report) ? 1 : 0)` — it reads only the report, not env vars.

To override a failing CI gate, you must:

1. Fix the underlying failure (preferred in all cases).
2. If a baseline approval is genuinely needed, follow Section 2 exactly — set `baseline_reviewed: true` and add a valid `_baseline_change_note` before the CI run.
3. If the failure is a known pre-existing issue unrelated to your PR: open a WI documenting it, assign an owner, and get a second human reviewer to confirm that the failure predates the PR before merging.

**A gate failure must never be resolved by skipping, commenting out, or patching the gate code.** Any change to `run_model_audit.js`, `compare_audit_snapshot.js`, or `audit_invariants.js` that loosens pass/fail criteria requires its own WI and a second reviewer sign-off.

---

## Quick Reference

| Task | Command |
|------|---------|
| Run full audit | `npm --prefix apps/worker run audit:all` |
| Run per-sport audit | `npm --prefix apps/worker run audit:nba` / `nhl` / `mlb` |
| Run weekly scorecard | `npm --prefix apps/worker run audit:scorecard` |
| Run performance drift report | `npm --prefix apps/worker run audit:performance` |
| Check registry counts | `jq '[.[] \| select(.card_family_status == "LIVE")] \| length' apps/worker/src/audit/card-family-registry.json` |
| Quarantine a family | Edit `apps/worker/src/audit/card-family-registry.json` — set status, odds_backed, executable, date, rationale |
| Promote a family | Same file — promote only after confirming odds lane is wired and tested |

**Family registry:** [`apps/worker/src/audit/card-family-registry.json`](../apps/worker/src/audit/card-family-registry.json)  
**Audit README:** [`apps/worker/src/audit/README.md`](../apps/worker/src/audit/README.md)  
**Weekly scorecard command:** `audit:scorecard` (WI-0731 review cycle)
