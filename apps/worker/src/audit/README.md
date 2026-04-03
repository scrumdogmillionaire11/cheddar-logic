# Model Audit — `apps/worker/src/audit/`

This directory contains the model audit stack: snapshot runner, comparator, scorecard, invariant checks, and the card family registry.

---

## Card Family Registry

**File:** [`card-family-registry.json`](./card-family-registry.json)

The registry is the single machine-readable source of truth for every card family's operational status. It prevents projection-only families from silently becoming pseudo-live.

### Status Values

| Status | Meaning |
|---|---|
| `LIVE` | Full odds pipeline active; cards are executable end-to-end. |
| `PROJECTION_ONLY` | No live odds lane; model runs on projections only. Cards must not be surfaced as picks until promoted. |
| `QUARANTINED` | Family has an active data or model correctness issue; cards must not be generated or surfaced. |

### Schema

Every entry must contain all six fields:

```json
{
  "family": "NBA_TOTAL",
  "card_family_status": "LIVE",
  "status_set_date": "2026-04-02",
  "status_rationale": "One sentence explaining why this status was set.",
  "odds_backed": true,
  "executable": true
}
```

Field rules:
- `odds_backed` must be `false` for `PROJECTION_ONLY` and `QUARANTINED` families.
- `executable` must be `false` for `PROJECTION_ONLY` and `QUARANTINED` families.
- `status_rationale` must not be a placeholder. It must cite the reason the status was set (e.g., a WI number, a missing odds lane, a detected drift issue).

### How to Promote a Family (PROJECTION_ONLY → LIVE)

1. Confirm a live odds lane is wired and tested for the family.
2. Update the registry entry:
   - Set `card_family_status` to `"LIVE"`.
   - Set `odds_backed` to `true`.
   - Set `executable` to `true`.
   - Update `status_set_date` to today.
   - Write a specific `status_rationale` — cite the WI or change that restored the odds lane.
3. Commit the registry change as its own commit with message: `feat(audit): promote <FAMILY> to LIVE — <one-line reason>`.
4. Do not silently overwrite `status_set_date` or `status_rationale` without updating both.

### How to Quarantine a Family

1. Update the registry entry:
   - Set `card_family_status` to `"QUARANTINED"`.
   - Set `odds_backed` to `false`.
   - Set `executable` to `false`.
   - Update `status_set_date` to today.
   - Write a specific `status_rationale` — cite the issue (data gap, model drift, etc.) and a WI that tracks remediation.
2. Commit the registry change as its own commit with message: `fix(audit): quarantine <FAMILY> — <one-line reason>`.

---

## Audit Files

| File | Purpose |
|---|---|
| `build_audit_snapshot.js` | Runs the full model pipeline against the golden fixture library and writes a snapshot. |
| `compare_audit_snapshot.js` | Diffs two snapshots and flags regressions or improvements. |
| `run_model_audit.js` | Orchestrates snapshot + comparison; used by CI gate. |
| `scorecard.js` | Generates the weekly model scorecard from audit data. |
| `performance_drift_report.js` | Produces a per-family drift summary for review. |
| `projection_evaluator.js` | Computes projection-only MAE, bias, directional accuracy, and calibration buckets from settled actuals. |
| `audit_invariants.js` | Enforces structural invariants on audit output (completeness, schema). |
| `audit_rules_config.js` | Threshold configuration for invariant checks (pass/warn/fail bands). |
| `fixture_loader.js` | Loads golden fixture data for snapshot runs. |
| `fixtures/` | Golden fixture library (locked inputs for reproducible audit runs). |
| `card-family-registry.json` | Operational status registry for all card families (see above). |

---

## Validation

To validate the registry schema and counts:

```bash
# Confirm all 8 required fields are present on every entry
cat apps/worker/src/audit/card-family-registry.json | \
  jq '[.[] | select(has("family") and has("card_family_status") and has("status_set_date") and has("status_rationale") and has("odds_backed") and has("executable"))] | length'

# Should return 4
jq '[.[] | select(.card_family_status == "LIVE")] | length' apps/worker/src/audit/card-family-registry.json

# Should return 4
jq '[.[] | select(.card_family_status == "PROJECTION_ONLY")] | length' apps/worker/src/audit/card-family-registry.json

# No PROJECTION_ONLY family should be executable
jq '[.[] | select(.card_family_status == "PROJECTION_ONLY" and .executable == true)] | length' apps/worker/src/audit/card-family-registry.json
# Should return 0
```
