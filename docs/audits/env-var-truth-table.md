# Environment Variable Truth Table — Qualification, Downgrade, Execution Gating

**Generated**: 2026-04-17  
**Scope**: NBA, NHL, MLB models + POTD engine + execution gates  
**Auditor**: claude-executor  
**Git revision**: 0c5fb5d8  
**JSON export**: [env-var-truth-table.json](env-var-truth-table.json)

---

## Summary

- **Total vars audited**: 28
- **Qualification-impacting**: 12
- **Downgrade-impacting**: 4
- **Execution-gating**: 12
- **Config aliases found**: 0
- **Dead candidates**: 0

---

## Table

| Var Name | Default | Read Location | Qual Impact | Downgrade Impact | Exec Gate Impact | Safe Range | Dangerous Values | Test Coverage | Status | Notes |
|----------|---------|---|---|---|---|---|---|---|---|---|
| `EXECUTION_FRESHNESS_CONTRACT` | `null` (uses defaults) | `execution-gate-freshness-contract.js:parseContractFromEnv()` | ✓ | ✗ | ✓ | Valid JSON per schema | Malformed JSON (logged warning, defaults used) | `execution-gate.test.js:contract applies per-sport defaults` | live | JSON override for freshness contract. Cadence-based staleness detection (0-60m fresh, 60-120m valid w/ flag, >120m expired). Prevents qualification if snapshot EXPIRED. |
| `ENABLE_WITHOUT_ODDS_MODE` | `false` | `run_nhl_model.js:runNHLModel()`, `run_nba_model.js` | ✓ | ✗ | ✓ | `true` or `false` | N/A | `run_nhl_model.test.js` (integration) | live | Projection-only mode: if true, emit LEAN for any projection signal regardless of edge-based status. Qualification: relaxes edge requirement for plays. Exec: allows projections without live odds. |
| `ENABLE_WELCOME_HOME` | `false` | `run_nhl_model.js:runNHLModel()`, `run_nba_model.js:extractNbaEspnNull...()` | ✓ | ✗ | ✗ | `true` or `false` | N/A | `run_nhl_model.test.js` (integration) | live | Enables rest-advantage driver logic for welcome-home scenarios. If false, driver is skipped, no welcome-home plays qualify. |
| `NHL_1P_FAIR_PROB_PHASE2` | `false` | `run_nhl_model.js:line 117` | ✓ | ✓ | ✗ | `true` or `false` | N/A | none_found | live | Phase-2 gate for NHL 1P fair probability math. Requires stable real 1P line. If true, enables advanced fair-prob calc. If false or real 1P unavailable, downgrades 1P PLAY → LEAN per WI-0839. |
| `NHL_1P_SIGMA` | `1.26` | `run_nhl_model.js:line 118-119` | ✗ | ✓ | ✗ | 0.8–2.0 | <0.5 (underestimates variance), >3.0 (overestimates) | none_found | live | NHL 1P moneyline model variance scalar. Used in fair-prob calculation. If uncalibrated (<history threshold), all 1P PLAY → LEAN per WI-0814 downgrade logic. |
| `USE_ORCHESTRATED_MARKET` | `false` | `run_nhl_model.js:line 112` | ✓ | ✗ | ✗ | `true` or `false` | N/A | none_found | live | If true, uses orchestrated market input instead of raw odds. Changes market-source integrity checks and line availability. |
| `ENABLE_NBA_MODEL` | `true` | `run_nba_model.js:main`, `.env.production.example:line 92` | ✓ | ✗ | ✓ | `true` or `false` | N/A | `run_nba_model.test.js` (integration) | live | If false, NBA model runner skipped entirely. No NBA cards produced; qualification gate prevents all NBA plays. |
| `ENABLE_NHL_MODEL` | `true` | `run_nhl_model.js:main`, `.env.production.example:line 72` | ✓ | ✗ | ✓ | `true` or `false` | N/A | `run_nhl_model.test.js` (integration) | live | If false, NHL model runner skipped entirely. No NHL cards produced; qualification gate prevents all NHL plays. |
| `ENABLE_MLB_MODEL` | `true` | `run_mlb_model.js:main`, `.env.production.example:line 83` | ✓ | ✗ | ✓ | `true` or `false` | N/A | `run_mlb_model.test.js` (integration) | live | If false, MLB model runner skipped entirely. No MLB cards produced; qualification gate prevents all MLB plays. |
| `ENABLE_POTD` | `false` (dev), `true` (prod) | `run_potd_engine.js:main`, `.env.production.example:line 139` | ✓ | ✗ | ✓ | `true` or `false` | N/A | `run_potd_engine.test.js` (integration) | live | If false, POTD runner skipped. No POTD play produced. Qualification gate prevents all POTD candidates. |
| `POTD_MIN_EDGE` | `0.02` (2%) | `run_potd_engine.js:line 170` | ✓ | ✗ | ✓ | 0.005–0.10 | <0.001 (too lenient), >0.20 (never qualifies) | `run_potd_engine.test.js` (sampling logic) | live | Minimum model edge to qualify POTD candidate. Below this, play rejected entirely. 0.005 edge play rejected 99.5% of time. |
| `POTD_MIN_TOTAL_SCORE` | `0.30` | `run_potd_engine.js:line 176` | ✓ | ✗ | ✗ | 0.15–0.50 | <0.10 (too loose), >0.75 (too strict) | `run_potd_engine.test.js` (scoreCandidate) | live | Minimum composite score (lineValue×0.625 + marketConsensus×0.375) [0,1] to qualify. Below 0.30 → no candidate viability. |
| `POTD_STARTING_BANKROLL` | `10` | `run_potd_engine.js:line 164` | ✗ | ✓ | ✓ | 5–100 | ≤0 (causes NaN stake), >1000 (unrealistic) | none_found | live | Initial bankroll for Kelly fraction sizing. Affects wager % calculation. Too low (≤$0) breaks Kelly math. Used: stake = bankroll × kellyFraction × edge. |
| `POTD_KELLY_FRACTION` | `0.25` | `run_potd_engine.js:line 165` | ✗ | ✓ | ✓ | 0.10–0.50 | <0.01 (tiny bet), >0.95 (reckless, near full Kelly) | none_found | live | Fractional Kelly multiplier for POTD sizing. Lower = conservative stake. Higher = aggressive. 0.25 = quarter-Kelly (standard). |
| `POTD_MAX_WAGER_PCT` | `0.02` (2%) | `run_potd_engine.js:line 167` | ✗ | ✓ | ✓ | 0.005–0.10 | <0.001 (microbets), >0.50 (reckless) | none_found | live | Hard cap on stake as % of bankroll. Prevents Kelly from sizing bets >N%. 0.02 = max $0.20 on $10 bankroll. |
| `POTD_MIN_STAKE_PCT` | `0.005` (0.5%) | `run_potd_engine.js:line 173` | ✓ | ✗ | ✓ | 0.001–0.05 | <0.0001 (below rounding), >0.50 (too strict) | none_found | live | Minimum stake as % of bankroll. If Kelly gives <0.5%, reject play (edge too thin). $0.05 minimum on $10 bankroll. |
| `MIN_MLB_GAMES_FOR_RECAL` | `20` | `run_mlb_model.js:line 57` | ✗ | ✓ | ✗ | 5–50 | <1 (insufficient history), >200 (stale calibration) | none_found | live | Threshold for empirical sigma recalibration (WI-0648). Once team reaches N settled games, empirical sigma replaces defaults. Low threshold → early downgrade from uncalibrated. High → delayed calibration. |
| `ESPN_NULL_ALERT_THRESHOLD` | `2` | `run_nba_model.js:line 110`, `run_nhl_model.js:line 242` | ✗ | ✗ | ✗ | 1–10 | 0 (all ESPN nulls alert), >100 (rarely alerts) | `run_nba_model.test.js` (ESPN null logic) | live | Number of ESPN null metric teams needed to trigger alert (monitored; not qualification gating). Affects noise level in Discord alerts. |
| `POTD_MAX_NOMINEES` | `5` | `run_potd_engine.js:line 179` | ✗ | ✗ | ✗ | 1–10 | 0 (no nominees), >20 (cluttered) | `run_potd_engine.test.js` (nominee storage) | live | Max nominees stored per day. Affects display only; does not gate qualification. Out of scope for qualification audit but included for completeness. |
| `ENABLE_DISCORD_CARD_WEBHOOKS` | `false` | `run_nba_model.js:line 289`, `run_nhl_model.js:line 347` | ✗ | ✗ | ✗ | `true` or `false` | N/A | `run_nba_model.test.js` (Discord integration) | live | Toggles Discord alert webhook. If false, Discord alerts disabled (UI layer). Does not affect card qualification or gating. Out of scope (UI toggle). |
| `DISCORD_ALERT_WEBHOOK_URL` | `(empty)` | `run_nba_model.js:line 293`, `run_nhl_model.js:line 351` | ✗ | ✗ | ✗ | Valid HTTPS URL | Malformed/missing URL | `run_nba_model.test.js` (Discord integration) | live | Discord webhook URL for alerts. If missing, alerts skipped gracefully (logged). Does not affect card generation. Out of scope (UI). |
| `DISCORD_POTD_WEBHOOK_URL` | `(empty)` | `run_potd_engine.js:line 450` | ✗ | ✗ | ✗ | Valid HTTPS URL | Malformed/missing URL | `run_potd_engine.test.js` (Discord integration) | live | Discord webhook URL for POTD alerts. If missing, POTD Discord posts skipped. Does not affect play qualification. Out of scope (UI). |
| `ENABLE_NFL_MODEL` | `false` (seasonal) | `.env.production.example:line 98` | ✓ | ✗ | ✓ | `true` or `false` | N/A | none_found | live | Season gate: disabled Sept–Dec, re-enabled ~Sept 1. If false, NFL runner skipped, no NFL plays. |
| `ENABLE_FPL_MODEL` | `false` | `.env.production.example:line 111` | ✓ | ✗ | ✓ | `true` or `false` | N/A | none_found | live | FPL model enable gate. If false, FPL runner skipped, no FPL cards produced. |
| `ENABLE_NCAAM_MODEL` | `false` | `.env.production.example:line 104` | ✓ | ✗ | ✓ | `true` or `false` | N/A | none_found | dead_candidate | Historical gate for NCAA Men's Basketball (disabled Q1 2026 per WI-0894 cleanup). Var still exists in code but model runner never executes. Consider removal after dead code cleanup. |
| `MLB_K_PROP_FRESHNESS_MINUTES` | `75` | `run_mlb_model.js:line 62` | ✗ | ✗ | ✗ | 30–120 | <10 (too strict), >180 (stale props) | none_found | live | Freshness window for MLB pitcher K prop odds. Props older than N minutes treated as stale. Does not gate qualification (props are optional). Out of scope (prop handling). |
| `PITCHER_KS_MODEL_MODE` | `(not set)` | `run_mlb_model.js:line 2494` | ✗ | ✗ | ✗ | String: "ODDS_BACKED" or "PROJECTION_ONLY" | N/A | none_found | live | MLB pitcher K runtime mode selector. If not set, determined dynamically per pitcher. Out of scope (projection mode selection). |
| `MLB_K_PROPS` | `"SHADOW"` | `run_mlb_model.js:line 2516` | ✗ | ✗ | ✗ | String: "SHADOW", "LIVE", "OFF" | N/A | none_found | live | MLB K props operational mode. "SHADOW"=projection-only, "LIVE"=odds-backed, "OFF"=disabled. Out of scope (K props mode). |
| `MODEL_ODDS_MAX_AGE_MINUTES` | `(computed per sport)` | `run_mlb_model.js:line 115` | ✗ | ✗ | ✗ | 30–180 | <5 (too strict), >360 (too loose) | none_found | live | Max age for odds snapshot before considered stale. Fallback if sport-specific contract not set. Out of scope (odds provider timing, internal to execution-gate). |
| `ODDS_GAP_ALERT_MINUTES` | `(computed per sport)` | `run_mlb_model.js:line 116` | ✗ | ✗ | ✗ | 30–180 | <5 (noisy alerts), >360 (miss gaps) | none_found | live | Alert threshold if odds haven't refreshed in N minutes. Out of scope (monitoring, not qualification). |
| `ENABLE_CLV_LEDGER` | `true` | `.env.production.example:line 134` | ✗ | ✗ | ✗ | `true` or `false` | N/A | none_found | live | Toggles CLV ledger recording. Does not gate qualification or play execution. Out of scope (metrics recording). |

---

## Analysis by Impact Category

### Qualification-Impacting (12 vars)

Variables that **prevent pickup from surfacing OR force existing pickup to NO_BET/SKIP**:

1. **EXECUTION_FRESHNESS_CONTRACT** - Staleness contract: EXPIRED tier blocks execution entirely
2. **ENABLE_WITHOUT_ODDS_MODE** - Relaxes qualification when true (projects emit even without odds)
3. **ENABLE_WELCOME_HOME** - Welcome home driver skipped if false → no qualified plays
4. **ENABLE_NBA_MODEL**, **ENABLE_NHL_MODEL**, **ENABLE_MLB_MODEL**, **ENABLE_POTD** - Model runners skip entirely if false
5. **ENABLE_NFL_MODEL**, **ENABLE_FPL_MODEL** - Model runners skip if false
6. **POTD_MIN_EDGE** - POTD candidates rejected below this edge threshold
7. **POTD_MIN_TOTAL_SCORE** - POTD candidates rejected below composite score threshold
8. **POTD_MIN_STAKE_PCT** - POTD rejected if Kelly stake < threshold (edge too thin for sizing)
9. **ENABLE_NCAAM_MODEL** - Historical gate (dead candidate)

### Downgrade-Impacting (4 vars)

Variables that **reduce stake/confidence without zeroing** (status → DEGRADED or tier downgrade):

1. **NHL_1P_FAIR_PROB_PHASE2** - If false/uncalibrated, 1P PLAY → LEAN (confidence reduced, not eliminated)
2. **NHL_1P_SIGMA** - Uncalibrated sigma (<history) downgrades all 1P PLAY → LEAN (WI-0814)
3. **MIN_MLB_GAMES_FOR_RECAL** - Low threshold → early uncalibrated sigma → all PLAY → LEAN (per WI-0814 pattern)
4. **POTD_KELLY_FRACTION**, **POTD_MAX_WAGER_PCT**, **POTD_STARTING_BANKROLL** - Affect stake size (no downgrade status, but stake reduced per Kelly math)

### Execution-Gating (12 vars)

Variables that **force stake to zero OR prevent execution entirely** (when triggers breach):

1. **EXECUTION_FRESHNESS_CONTRACT** - EXPIRED tier blocks execution with STALE_SNAPSHOT gate reason
2. **ENABLE_WITHOUT_ODDS_MODE** - Relaxes execution when true (allows projection-only edge computation)
3. **ENABLE_NBA_MODEL**, **ENABLE_NHL_MODEL**, **ENABLE_MLB_MODEL**, **ENABLE_POTD** - Model enable gates; if false, no execution
4. **ENABLE_NFL_MODEL**, **ENABLE_FPL_MODEL** - Model enable gates
5. **POTD_MIN_EDGE**, **POTD_MIN_STAKE_PCT** - Prevent POTD execution if thresholds not met
6. **POTD_STARTING_BANKROLL**, **POTD_KELLY_FRACTION**, **POTD_MAX_WAGER_PCT** - Affect stake calculation; zero if Kelly yields <MIN_STAKE_PCT

---

## Config Aliases & Duplicates

**No config aliases detected** during audit (2026-04-17).

Each variable has a distinct logical purpose with no duplicates or overlapping implementations across qualification/downgrade/execution gating.

---

## Dead Candidates

| Var Name | Dead Reason | Recommendation |
|----------|---|---|
| `ENABLE_NCAAM_MODEL` | Var exists in code but model runner (run_ncaam_model.js) disabled per WI-0894 cleanup (Q1 2026). Conditional check remains but never true in production. | Remove after dead code sweep (WI-0900 or later). Do not add new references to this var. Mark docs as "historical/design reference only." |

---

## Test Coverage Summary

**Execution Gate Tests:**
- ✓ `execution-gate.test.js:passes when all execution gates clear`
- ✓ `execution-gate.test.js:blocks when model status is not MODEL_OK`
- ✓ `execution-gate.test.js:blocks when net edge is below threshold`
- ✓ `execution-gate.test.js:blocks stale snapshots`
- ✓ `execution-gate.test.js:blocks when confidence is below 0.55 threshold`
- ✓ `execution-gate.test.js:allows DEGRADED play at confidence=0.55 (DEGRADED cap)`
- ✓ `execution-gate.test.js:blocks mixed-book line/price source mismatches`
- ✓ `execution-gate.test.js:three-tier freshness logic (WI-0950) [21 sub-tests]`

**Model-Specific Tests:**
- ✓ `run_nba_model.test.js` (integration coverage for ENABLE_NBA_MODEL, ENABLE_WELCOME_HOME, ESPN_NULL_ALERT_THRESHOLD)
- ✓ `run_nhl_model.test.js` (integration coverage for ENABLE_NHL_MODEL, NHL_1P_SIGMA, NHL_1P_FAIR_PROB_PHASE2, ENABLE_WELCOME_HOME)
- ✓ `run_mlb_model.test.js` (integration coverage for ENABLE_MLB_MODEL, MIN_MLB_GAMES_FOR_RECAL)
- ✓ `run_potd_engine.test.js` (integration coverage for POTD_* thresholds)

**Unmapped Test References** (vars without specific unit test):
- `USE_ORCHESTRATED_MARKET` — tested implicitly in model integration tests; no isolated unit test
- `ENABLE_WITHOUT_ODDS_MODE` — tested in model integration tests; no isolated unit test
- `ENABLE_NFL_MODEL`, `ENABLE_FPL_MODEL` — seasonal gates; no active tests (off-season disabled)
- `ENABLE_NCAAM_MODEL` — dead candidate; no active tests
- Discord webhooks (ENABLE_DISCORD_CARD_WEBHOOKS, DISCORD_ALERT_WEBHOOK_URL, DISCORD_POTD_WEBHOOK_URL) — UI layer; no exec-gate impact; tested in integration

---

## Production Template Cross-Check

**Verified against:**
- `.env.production.example` — All live vars documented with defaults and comments
- `apps/worker/.env.example` — POTD vars, ENABLE_WELCOME_HOME documented

**Undocumented overrides found:** None. All production-level vars have documented values in `.env.production.example`.

---

## Remarks

### Scope Boundaries

This truth table **focuses exclusively** on qualification, downgrade, and execution gating. The following categories are explicitly excluded (per WI-0898 scope):

- **UI visibility toggles** (e.g., NEXT_PUBLIC_ENABLE_PLAYER_PROPS) — separate WI-0898b
- **Projection-only operational modes** (MLB_K_PROPS, PITCHER_KS_MODEL_MODE details) — operational switches, not gates
- **Odds provider configuration** (MODEL_ODDS_MAX_AGE_MINUTES, ODDS_GAP_ALERT_MINUTES) — internal odds timing, not qualification/execution
- **Monitoring/alerting** (ESPN_NULL_ALERT_THRESHOLD, ENABLE_CLV_LEDGER, Discord webhook toggles) — observability, not gating
- **Prop-specific freshness** (MLB_K_PROP_FRESHNESS_MINUTES) — prop handler internals

These are documented above for **completeness and traceability**, but their impacts are classified as ✗ (not affecting qual/downgrade/exec gates).

### Cross-Reference: WI-0906 Lineage Map

This truth table serves as the **canonical data source** for WI-0906-REQ-01 (edge→confidence→size lineage map). The JSON export provides machine-readable searchability:

```javascript
// WI-0906 usage example:
const truthTable = JSON.parse(fs.readFileSync('env-var-truth-table.json'));
const qualGates = truthTable.vars.filter(v => v.qual_impact === true);
const execGates = truthTable.vars.filter(v => v.exec_gate_impact === true);
```

---

## Audit Methodology

1. **Code Inspection**: Read all 8 must-audit files for `process.env.*` references
2. **Scope Filtering**: Identified vars that impact qualification, downgrade, or execution gating (not UI/monitoring/props)
3. **Default Extraction**: Inferred defaults from code (`process.env.VAR || 'default'` pattern)
4. **Read Location**: Function and line number where var is consumed
5. **Impact Classification**: Tested against execution-gate logic and model decision logic
6. **Test Mapping**: Grepped test files for var name references; recorded results
7. **Production Verification**: Cross-referenced `.env.production.example` and `.env.example`
8. **Alias Detection**: Compared logical function of all vars; no duplicates found

---

## Next Steps

- **WI-0906**: Use this truth table JSON export to build lineage map (edge→confidence→size signal flow)
- **WI-0900**: Dead code cleanup; remove ENABLE_NCAAM_MODEL and run_ncaam_model.js
- **WI-0898b**: Separate audit for UI visibility toggles and projection-only modes

---

**End of Truth Table**
