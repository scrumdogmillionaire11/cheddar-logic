# Model Audit Weekly Scorecard — 2026-W14

**Run date:** 2026-04-02  
**Run scope:** `manual-2026-04-02T18-25-52-946Z`  
**Generated at:** 2026-04-02T18:25:52.946Z  
**Scorecard archive:** `apps/worker/src/audit/outputs/scorecards/scorecard-2026-W14.json`  
**First scorecard:** Yes — this is the baseline lock review (post WI-0728 / WI-0730)

---

## Summary

| Metric | Value |
|--------|-------|
| Total fixtures | 18 |
| Passed | 18 |
| Failed | 0 |
| Critical | 0 |
| High severity | 0 |
| Warnings | 6 |
| Performance alerts | 1 |

---

## Family Ranking Table

| Card family      | Audit stability | Performance status | Operational status |
|------------------|-----------------|--------------------|--------------------|
| NBA_TOTAL        | Medium          | Watch              | LIVE               |
| NBA_SPREAD       | Medium          | Watch              | LIVE               |
| NHL_TOTAL        | Medium          | Watch              | LIVE               |
| NHL_ML           | Medium          | Watch              | LIVE               |
| NHL_1P_TOTAL     | Medium          | Not executable     | PROJECTION_ONLY    |
| NHL_PLAYER_SHOTS | Medium          | Not executable     | PROJECTION_ONLY    |
| MLB_PITCHER_K    | High            | Not executable     | PROJECTION_ONLY    |
| MLB_F5_TOTAL     | Medium          | Not executable     | PROJECTION_ONLY    |

**Audit stability key:**
- **High** — 4+ fixtures, all passing, no warnings
- **Medium** — warnings present, or fewer than 3 fixtures in corpus
- **Low** — critical or failed fixtures (none this week)

**Performance status key:**
- **Healthy** — LIVE family, no drift or performance alerts
- **Watch** — LIVE family flagged with `WARN_AUDIT_DRIFT` or performance alert; monitor before promotion
- **Not executable** — `PROJECTION_ONLY` family; no live odds lane active

---

## Family Detail

### NBA_TOTAL — Watch ⚠️

- **Risk:** MEDIUM
- **Fixtures:** 4 (all passed, 2 warnings)
- **Flags:** `WARN_AUDIT_DRIFT`, `WARN_PERFORMANCE_ALERT:PASS_RATE_COLLAPSE`
- **Model decay:** `true`
- **Trend:** executable_rate=UP, pass_rate=STABLE, calibration=STABLE
- **Operational:** LIVE
- **Note:** Pass-rate collapse alert (threshold 20%, last_200 window = 0) and model decay flag. Audit drift present. Requires active monitoring. Do not treat pass_rate STABLE in audit fixtures as equivalent to production pass rate health — the alert reflects live model output data.

### NBA_SPREAD — Watch ⚠️

- **Risk:** MEDIUM
- **Fixtures:** 1 (passed, 1 warning)
- **Flags:** `WARN_AUDIT_DRIFT`
- **Trend:** all STABLE
- **Operational:** LIVE
- **Note:** Audit drift with single fixture coverage. Corpus expansion needed for Higher stability rating.

### NHL_TOTAL — Watch ⚠️

- **Risk:** MEDIUM
- **Fixtures:** 3 (all passed, 2 warnings)
- **Flags:** `WARN_AUDIT_DRIFT`
- **Trend:** executable_rate=UP, pass_rate=STABLE, calibration=STABLE
- **Operational:** LIVE
- **Note:** Audit drift. Executable rate trending UP may indicate boundary cases being promoted. Watch for quality regression over next 2-week window.

### NHL_ML — Watch ⚠️

- **Risk:** MEDIUM
- **Fixtures:** 1 (passed, 1 warning)
- **Flags:** `WARN_AUDIT_DRIFT`
- **Trend:** all STABLE
- **Operational:** LIVE
- **Note:** Minimal fixture coverage. Expand corpus before next scorecard.

### NHL_1P_TOTAL — Not executable

- **Risk:** LOW
- **Fixtures:** 1 (passed, 0 warnings)
- **Flags:** none
- **Operational:** PROJECTION_ONLY
- **Note:** Per-event first-period odds lane removed (WI-0727). Audit fixtures pass cleanly. No progression path until odds lane restored.

### NHL_PLAYER_SHOTS — Not executable

- **Risk:** LOW
- **Fixtures:** 1 (passed, 0 warnings)
- **Flags:** none
- **Operational:** PROJECTION_ONLY
- **Note:** Per-event shots odds lane removed (WI-0727). Audit fixtures pass cleanly.

### MLB_PITCHER_K — Not executable

- **Risk:** LOW
- **Fixtures:** 4 (all passed, 0 warnings)
- **Flags:** none
- **Operational:** PROJECTION_ONLY
- **Note:** Highest fixture coverage of PROJECTION_ONLY families. Clean audit run. Strongest candidate for re-activation when odds lane is available.

### MLB_F5_TOTAL — Not executable

- **Risk:** LOW
- **Fixtures:** 2 (all passed, 0 warnings)
- **Flags:** none
- **Operational:** PROJECTION_ONLY
- **Note:** Per-event F5 total odds lane removed (WI-0727). Clean audit pass.

---

## Actions

### Families flagged for Watch

All four LIVE families carry a `Watch` status this week due to `WARN_AUDIT_DRIFT` signals. This is expected for the first scorecard after baseline lock — the drift flag reflects the delta between first-run computed baselines and audit fixture expectations, not production failure.

| Family | Primary concern | Next action |
|--------|----------------|-------------|
| NBA_TOTAL | model_decay=true + PASS_RATE_COLLAPSE alert | Investigate production pass rate; draft WI if decay confirmed |
| NBA_SPREAD | Audit drift, thin fixture corpus (1 fixture) | Add 2–3 fixtures covering edge cases by 2026-W16 |
| NHL_TOTAL | Audit drift + executable_rate trending UP | Monitor executable rate over 2026-W14 to W16; draft WI if rate continues rising |
| NHL_ML | Audit drift, thin fixture corpus (1 fixture) | Add 2–3 fixtures by 2026-W16 |

**Next scorecard review date:** 2026-04-09 (2026-W15)

### PROJECTION_ONLY families

No action required this cycle. Future WI needed to restore odds lanes before any family can be promoted to LIVE.

---

## Notes

- This is the first scorecard run post baseline lock (WI-0728) and family registry setup (WI-0730).
- All 8 registry families have a row. No silent omissions.
- No PROJECTION_ONLY family is listed with an "executable" performance status.
- Passing audit fixtures does not imply model quality — audit stability and production performance are separate axes (per AGENTS.md and WI-0725).
- PROJECTION_ONLY families must not be surfaced as executable until a live odds lane is restored and a promotion WI is approved.
- Edge retention review (2–4 week window): target 2026-W17 as a checkpoint WI.
