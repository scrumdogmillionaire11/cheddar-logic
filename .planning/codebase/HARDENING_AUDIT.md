# REPO HARDENING AUDIT

**Analysis Date:** 2026-04-11  
**Auditor Mode:** Hostile Systems Reviewer  
**Scope:** cheddar-logic — full repo, all layers

---

## Executive Summary

1. **[CRITICAL]** Web `derivePlayDecision()` re-derives classification using `THRESHOLDS.TOTAL.base_edge_threshold: 0.02` (2%). Backend PLAY minimum is 5-6.2%. A card legitimately scored PASS by the authoritative model can be re-emitted as `FIRE` to users by the web transform layer.
2. **[CRITICAL]** `applyExecutionGateToNhlCard()` overwrites `action/classification/status → PASS` AFTER `publishDecisionForCard()` has already written `decision_v2.official_status: PLAY`. The stored payload is internally contradictory. Settlement reads `decision_v2.official_status` and scores the card as a PLAY; Discord reads `action` and shows PASS. The same card is simultaneously "not a recommendation" and "a tracked bet result."
3. **[CRITICAL]** `STALE_BLOCK_THRESHOLD_MINUTES = 150` (2.5 hours) with explicit TODO: `// TODO: tighten back to 30 min once hourly odds pulls are restored`. Watchdog CAUTION at this range does NOT block LEAN cards. Users receive recommendations priced against 2.5-hour-old lines.
4. **[HIGH]** NHL runner never checks `marketDecisions.status === 'NO_BET'` before calling `selectExpressionChoice()` and `generateNHLMarketCallCards()`. DOUBLE_UNKNOWN_GOALIE returns a flat `{status:'NO_BET'}` object with no TOTAL/SPREAD/ML keys. Zero cards are emitted silently; the pipeline state is never updated to reflect NO_BET.
5. **[HIGH]** Two incompatible tier vocabularies coexist simultaneously: `determineTier()` → `SUPER/BEST/WATCH/null`; `derivePlayTierWithThresholds()` → `BEST/GOOD/OK/BAD`. `deriveAction()` only handles the first vocabulary. Any card with `play_tier=GOOD/OK/BAD` gets `action=PASS` via silent fallthrough.
6. **[HIGH]** Dual NBA projection formulas active in the same job run: deprecated `projectNBA()` (multiplicative pace) used in `computeNBADriverCards()` and correct `projectNBACanonical()` (additive pace) used in `computeNBAMarketDecisions()`. Driver cards and market-call cards for the same game can project opposing sides.
7. **[HIGH]** `CANONICAL_EDGE_CONTRACT.EDGE_UPGRADE_MIN: 0.5` (50 pp) makes the flip mechanism permanently inoperative. Real-world edge delta never approaches 0.5. The system cannot self-correct side assignment under any realistic circumstances.
8. **[HIGH]** `computeSigmaFromHistory()` swallows all DB errors silently (`catch (_err) { return fallback }`). DB failure is indistinguishable from "insufficient history." Entire job run degrades to LEAN with no visible error.
9. **[MEDIUM]** `assertNoDecisionMutation()` is `console.warn`-only in production. Post-publish invariant breach is silently tolerated. Corrupted decision state is stored to DB and downstream systems read it.
10. **[MEDIUM]** NHL SPREAD/PUCKLINE markets have no entry in `SPORT_MARKET_THRESHOLDS_V2`. With `ENABLE_MARKET_THRESHOLDS_V2: true` (default), these markets fall through to generic defaults (`play_edge_min=0.06`) — the same value used for NBA, not calibrated for NHL line structure.

---

## System Map

```
Ingestion / Data Pull
  apps/worker/src/jobs/pull_odds_hourly.js         → odds_snapshots table (DB write, worker-only)
  apps/worker/src/jobs/pull_espn_games_direct.js   → espn_metrics enrichment
  apps/worker/src/jobs/ingest_nst_*.js             → special teams, XGF rates
  apps/worker/src/jobs/moneypuck_job.js            → MoneyPuck shot/expected-goals rates

Normalization
  apps/worker/src/jobs/normalize-raw-data-payload.js → ESPN metric extraction
  packages/data/src/db-path.js                       → DB connection

Model Computation (per sport)
  ┌─ apps/worker/src/jobs/run_nba_model.js
  │     ├─ computeNBADriverCards()     ← apps/worker/src/models/index.js:1499 (@deprecated projectNBA)
  │     └─ computeNBAMarketDecisions() ← apps/worker/src/models/cross-market.js:922 (projectNBACanonical)
  ├─ apps/worker/src/jobs/run_nhl_model.js
  │     └─ computeNHLMarketDecisions() ← apps/worker/src/models/cross-market.js:364 (projectNHL)
  ├─ apps/worker/src/jobs/run_mlb_model.js
  │     └─ mlb-model.js → resolveOffenseComposite()
  └─ packages/models/src/
        ├─ projections.js          → projectNBACanonical, projectNHL, projectNBA (deprecated)
        ├─ edge-calculator.js      → computeSpreadEdge, computeTotalEdge, computeSigmaFromHistory
        └─ decision-pipeline-v2.js → buildDecisionV2 (wave1 sports: NBA/NHL)

Guardrails / Decision
  packages/models/src/decision-pipeline-v2.js          → buildDecisionV2, computeOfficialStatus
  packages/models/src/decision-pipeline-v2-edge-config.js → resolveThresholdProfile
  packages/models/src/decision-gate.js                 → CANONICAL_EDGE_CONTRACT, shouldFlip
  apps/worker/src/models/input-gate.js                 → classifyModelStatus, DEGRADED_CONSTRAINTS
  apps/worker/src/jobs/execution-gate.js               → evaluateExecution (MAX_SNAPSHOT_AGE 5min)
  apps/worker/src/models/calibration-gate.js           → isMarketCalibrationEnabled (kill-switch)

Publish / Storage
  apps/worker/src/utils/decision-publisher.js   → finalizeDecisionFields, applyUiActionFields
                                                   assertNoDecisionMutation (warn-only in prod)
  run_nhl_model.js / run_nba_model.js           → insertCardPayload → card_payloads table

Output
  apps/worker/src/jobs/post_discord_cards.js    → classifyDecisionBucket (reads action, classification)
  apps/worker/src/jobs/settle_pending_cards.js  → reads decision_v2.official_status (NOT action)
  apps/worker/src/jobs/settle_game_results.js   → joins game_results with card_results

Web API (read-only)
  web/src/app/api/cards/route.ts                       → getDatabaseReadOnly() only
  web/src/lib/game-card/transform/index.ts:1929        → derivePlayDecision() re-derives on every card
  web/src/lib/play-decision/decision-logic.ts:183      → uses THRESHOLDS (divergent from backend)
```

**Decision Field Inconsistency Zone (the triangle of failure):**
```
publishDecisionForCard()  → writes decision_v2.official_status = PLAY
         ↓ (already written)
applyExecutionGateToNhlCard() → writes action = PASS, classification = PASS
         ↓
card_payloads row: { decision_v2.official_status: PLAY, action: PASS }
         ↓
post_discord_cards.js reads action → PASS → shown as not actionable
settle_pending_cards.js reads decision_v2.official_status → PLAY → scored as tracked bet
web transform reads action → PASS (correctly shows PASS)
```

---

## Critical Findings

### CF-001 — [CRITICAL] Web Layer Re-Derives Classification With 3x Lower Threshold

**Why it matters:**
The web transform re-decides card classification independently of the backend model. A card rejected by the model (official_status=PASS, edge=4%) can be re-classified as BASE→FIRE by the web layer, which uses a 2% threshold. Users receive and act on recommendations the model explicitly declined to make.

**Evidence:**
- `web/src/lib/play-decision/decision-logic.ts:183` — `adjustedThreshold = thresholds.base_edge_threshold ?? 0.02`
- `web/src/lib/types/canonical-play.ts:280` — `TOTAL.base_edge_threshold: 0.02`
- `web/src/lib/types/canonical-play.ts:285` — `MONEYLINE.base_edge_threshold: 0.025`
- `packages/models/src/decision-pipeline-v2-edge-config.js:52` — `NBA:TOTAL.play_edge_min: 0.062` (6.2%)
- `packages/models/src/decision-pipeline-v2-edge-config.js:47` — `NHL:TOTAL.play_edge_min: 0.05` (5%)
- `web/src/lib/game-card/transform/index.ts:1929` — `derivePlayDecision(playForDecision, marketContext, {sport})` is called unconditionally in the live transform path

**Failure mode:**
NBA total card: edge=4%, model scores PASS (below 6.2% play_edge_min), stored as `decision_v2.official_status=PASS`. Web transform calls `derivePlayDecision()`, gets `edge > 0.02 → classification=BASE → action=FIRE`. Card renders as a live PLAY recommendation. Discord reads stored `action=PASS` and does not post. The web UI and Discord are out of sync on the same card.

**Current behavior:**
`derivePlayDecision` is invoked unconditionally at line 1929 in transform. Its result populates `decision` on the transformed card object. There is no guard that skips re-derivation when `decision_v2.official_status` is stored.

**Required fix:**
`web/src/lib/game-card/transform/index.ts:1929` — Add guard:
```javascript
// Before derivePlayDecision(), check for authoritative stored decision
if (payload?.decision_v2?.official_status) {
  // Use stored decision only — backend is authoritative
  const storedStatus = payload.decision_v2.official_status;
  decision = { official_status: storedStatus, classification: mapStatusToClassification(storedStatus) };
} else {
  decision = derivePlayDecision(playForDecision, marketContext, { sport });
}
```
`web/src/lib/types/canonical-play.ts` — Add `@deprecated` comment on THRESHOLDS block.

**Tests required:**
- Unit: card with `decision_v2.official_status=PASS` and `edge=0.04` → transformed card must NOT have `action=FIRE`
- Unit: card with `decision_v2.official_status=PLAY` and `edge=0.06` → transformed card must have `action=FIRE`
- Integration: web API response for stored PASS card must never return `action` of FIRE or HOLD

**Spec impact:**
Needs `docs/decisions/ADR-XXXX.md`: "Backend decision is sole authoritative source; web reads `decision_v2.official_status` only and must not re-derive thresholds."

---

### CF-002 — [CRITICAL] Execution Gate Writes action=PASS After decision_v2.official_status=PLAY Already Stored

**Why it matters:**
The execution gate runs after `publishDecisionForCard()` has already set `decision_v2.official_status`. When the gate blocks, it writes `action=PASS` but cannot reach back to update `decision_v2`. The stored row carries contradictory state. Settlement reads `decision_v2.official_status`, scores the card as an active PLAY, and when the game result comes in, that card is tracked and attributed — for a pick that was never surfaced to users as actionable.

**Evidence:**
- `apps/worker/src/jobs/run_nhl_model.js:2428` — `publishDecisionForCard(card, ...)` called (writes `decision_v2`)
- `apps/worker/src/jobs/run_nhl_model.js:2457` — `applyExecutionGateToNhlCard(card, ...)` called after
- `apps/worker/src/jobs/run_nhl_model.js:519-529` — gate overwrites `classification, action, status, ui_display_status, execution_status, ev_passed, actionable, publish_ready, pass_reason_code` but NOT `decision_v2.official_status`
- `apps/worker/src/jobs/settle_pending_cards.js:612` — settlement reads `payloadData?.decision_v2?.official_status` as primary

**Failure mode:**
Card blocked by gate: stored as `{ decision_v2: { official_status: 'PLAY' }, action: 'PASS' }`. Settlement awaits game result, scores the card as a PLAY result. Appears in CLV and performance metrics as a tracked bet. Users were never shown the pick; the system incorrectly attributes a win or loss to this card.

**Required fix:**
Option A (preferred): Move execution gate evaluation to BEFORE `publishDecisionForCard`. If gate blocks, skip `publishDecisionForCard` entirely and write a PASS card directly.

Option B: `applyExecutionGateToNhlCard` must also update `card.decision_v2.official_status = 'PASS'` when blocking, and write `decision_v2.pass_reason_code = gateResult.blocked_by.join(',')`.

Option C (belt-and-suspenders): `settle_pending_cards.js` — when `action=PASS` and `decision_v2.official_status=PLAY`, emit INVARIANT_BREACH log and treat as non-actionable.

**Tests required:**
- Unit: after execution gate blocks, card must have `decision_v2.official_status === 'PASS'` AND `action === 'PASS'`
- Integration: gate-blocked card must not appear in settlement query results

---

### CF-003 — [CRITICAL] Stale Snapshot Threshold Permanently Loosened (150 min, TODO to 30 min)

**Why it matters:**
Watchdog CAUTION at 5-150 min does NOT block LEAN cards. The play cleanliness cap only demotes PLAY→LEAN, not LEAN→PASS. A card can surface as `official_status=LEAN` using 2.5-hour-old odds data. Markets move. The probability edge computed against a 150-minute-old line may be negative against the current line.

**Evidence:**
- `packages/models/src/decision-pipeline-v2.js:1118-1120` — `// TODO: tighten back to 30 min\nconst STALE_BLOCK_THRESHOLD_MINUTES = 150`
- `packages/models/src/decision-pipeline-v2.js:1134-1142` — CAUTION is set at `ageMinutes > 5 && ageMinutes <= 150`, BLOCKED at `> 150`
- `packages/models/src/decision-pipeline-v2.js:884` — `computeOfficialStatus`: if `watchdogStatus === 'BLOCKED'` → PASS; if `=== 'CAUTION'` → allowed through

**Required fix:**
- Replace magic constant with `const STALE_BLOCK_THRESHOLD_MINUTES = parseInt(process.env.WATCHDOG_STALE_THRESHOLD_MINUTES ?? '30', 10)`, add floor of 15.
- CAUTION threshold for LEAN cards should also be tightened (e.g., LEAN blocked when `ageMinutes > 90`).

**Tests required:**
- Unit: card with 91-minute-old snapshot and `official_status=LEAN` → with threshold=30 → `official_status=PASS`

---

### CF-004 — [HIGH] NHL NO_BET Path Silently Produces Zero Cards With No Pipeline State Update

**Why it matters:**
`computeNHLMarketDecisions()` returns a flat `{status:'NO_BET', reason_detail:'DOUBLE_UNKNOWN_GOALIE'}` object when both goalies are unknown — no `.TOTAL`, `.SPREAD`, or `.ML` keys. `run_nhl_model.js` calls `selectExpressionChoice(marketDecisions)` and `generateNHLMarketCallCards()` immediately with this object. Zero cards are generated. The pipeline state is set to `driversReady:false` — identical to "ESPN data unavailable." The DOUBLE_UNKNOWN_GOALIE reason is never written to `gamePipelineStates`. Monitoring cannot distinguish a valid NO_BET from a broken data feed.

**Evidence:**
- `apps/worker/src/models/cross-market.js:364-376` — DOUBLE_UNKNOWN_GOALIE returns `buildNoBetResult([...], {projection_source:'NO_BET', reason_detail:'DOUBLE_UNKNOWN_GOALIE'})`
- `apps/worker/src/jobs/run_nhl_model.js:2239` — no guard on `marketDecisions.status` after `computeNHLMarketDecisions()` call
- `apps/worker/src/jobs/run_nhl_model.js:2287-2300` — pipeline state set based on `driverCards.length === 0` only

**Required fix:**
```javascript
// apps/worker/src/jobs/run_nhl_model.js, after line 2239:
const marketDecisions = computeNHLMarketDecisions(enrichedSnapshot);
if (marketDecisions?.status === 'NO_BET') {
  const reason = marketDecisions.reason_detail ?? marketDecisions.reason ?? 'NO_BET';
  console.log(`  [NO_BET] ${gameId}: ${reason}`);
  gamePipelineStates[gameId] = buildGamePipelineState({
    oddsSnapshot,
    projectionReady: false,
    driversReady: false,
    pricingReady: false,
    cardReady: false,
    blockingReasonCodes: [reason],
  });
  noBetCount++;
  continue;
}
```

**Tests required:**
- Integration: NHL game with `DOUBLE_UNKNOWN_GOALIE` → `gamePipelineStates[gameId].blockingReasonCodes` must include `'DOUBLE_UNKNOWN_GOALIE'`
- Unit: `computeNHLMarketDecisions` returns object with `status === 'NO_BET'` when both goalies are unknown

---

### CF-005 — [HIGH] Dual Tier Vocabularies Create Silent PASS Promotion

**Why it matters:**
`determineTier()` (legacy, `models/index.js`) returns `SUPER/BEST/WATCH/null`. `derivePlayTierWithThresholds()` (canonical, `decision-pipeline-v2.js`) returns `BEST/GOOD/OK/BAD`. `deriveAction()` only handles the legacy vocabulary — `GOOD`, `OK`, `BAD` fall through to `return 'PASS'`. Any non-wave1 card (FPL, prop, legacy market) with `play_tier=GOOD` silently gets `action=PASS` regardless of its true threshold position.

**Evidence:**
- `apps/worker/src/models/index.js:386-392` — `determineTier: confidence >= 0.75 ? 'SUPER' : ... 'WATCH' : null`
- `packages/models/src/decision-pipeline-v2.js:856-862` — `derivePlayTierWithThresholds: → 'BEST'/'GOOD'/'OK'/'BAD'`
- `apps/worker/src/utils/decision-publisher.js:31-36` — `deriveAction: SUPER→FIRE, BEST→HOLD, WATCH→HOLD, else→PASS`
- `web/src/lib/game-card/transform/index.ts:88` — `TIER_SCORE: {BEST:1, SUPER:0.72, WATCH:0.52}` — GOOD/OK/BAD have no score

**Required fix:**
`apps/worker/src/utils/decision-publisher.js:32-36`:
```javascript
if (t === 'SUPER') return 'FIRE';
if (t === 'BEST') return 'HOLD';
if (t === 'GOOD') return 'HOLD'; // ADD: decision-pipeline-v2 vocabulary
if (t === 'WATCH') return 'HOLD';
if (t === 'OK') return 'PASS';   // ADD: below threshold but not error
return 'PASS';
```
`web/src/lib/game-card/transform/index.ts:88`:
```javascript
TIER_SCORE: { BEST: 1, SUPER: 0.72, GOOD: 0.6, WATCH: 0.52, OK: 0.3, BAD: 0.0 }
```

**Tests required:**
- Unit: `deriveAction({ tier: 'GOOD' })` must return `'HOLD'`
- Unit: `deriveAction({ tier: 'BAD' })` must return `'PASS'`

---

### CF-006 — [HIGH] Dual NBA Projection Formulas Active Simultaneously

**Why it matters:**
`computeNBADriverCards()` in `models/index.js:1499` calls `projectNBA()` — explicitly marked `@deprecated` in `projections.js:144`. `computeNBAMarketDecisions()` calls `projectNBACanonical()`. Both run for every NBA game in `run_nba_model.js`. The deprecated formula uses multiplicative pace (`total * paceMultiplier`); the canonical uses additive (`projected + paceAdjustment`). For a high-pace game, the deprecated formula projects 238 total, the canonical projects 232. Driver card fires OVER; market-call card fires UNDER. Both cards write to `card_payloads` for the same game.

**Evidence:**
- `apps/worker/src/models/projections.js:144` — `@deprecated Use projectNBACanonical + analyzePaceSynergy instead.`
- `apps/worker/src/models/index.js:1499` — `const projection = projectNBA(...)`
- `apps/worker/src/jobs/run_nba_model.js:1490` — `computeNBADriverCards(...)` called
- `apps/worker/src/jobs/run_nba_model.js:1570` — `computeNBAMarketDecisions(...)` called
- `apps/worker/src/jobs/post_discord_cards.js:287-295` — `marketConflictKey` deduplicates by `game_id + market_type`; most-recent card wins

**Required fix:**
`apps/worker/src/models/index.js:1499` — Replace `projectNBA(...)` call with `projectNBACanonical(...)` + `analyzePaceSynergy(...)`. Run dual-projection comparison tests to verify total projections within ±2 points on a sample game.

**Tests required:**
- Unit: `computeNBADriverCards` and `computeNBAMarketDecisions` with same inputs → total projections within ±2 pts

---

### CF-007 — [HIGH] EDGE_UPGRADE_MIN = 0.5 Makes Flip Mechanism Permanently Inoperative

**Why it matters:**
`CANONICAL_EDGE_CONTRACT.EDGE_UPGRADE_MIN: 0.5` requires a 50 percentage-point edge improvement for a flip to be permitted. Real-world edge delta never reaches 0.5 (typical: 0.02-0.12). `shouldFlip()` in `decision-gate.js:349` is permanently false. The model cannot self-correct side assignment under any realistic operating conditions.

**Evidence:**
- `packages/models/src/decision-gate.js:29` — `EDGE_UPGRADE_MIN: 0.5`
- `packages/models/src/decision-gate.js:349` — `if (edgeDelta !== null && edgeDelta >= config.EDGE_UPGRADE_MIN) { return true }`

**Required fix:**
Either:
- Set `EDGE_UPGRADE_MIN: 0.04` (4pp) if flips are intended in production
- OR rename to `FLIP_DISABLED: true` and document the explicit decision not to allow flips

**Tests required:**
- Unit: `shouldFlip()` with `edgeDelta=0.04` must return `true`

---

### CF-008 — [HIGH] Playoff Sigma Multiplier May Lose sigma_source — Disabling WI-0814 Safety Gate

**Why it matters:**
`applyPlayoffSigmaMultiplier()` spreads the sigma object and multiplies only `spread` and `total` keys. The `margin` field (NHL sigma shape) exists on the source but is NOT listed in the output spread. The `spread` key does not exist in the NHL sigma shape, so `sigma.spread * multiplier = NaN`. More critically, the function has no unit tests. If `sigma_source` is ever not preserved by a spread (e.g., in a refactor), `buildDecisionV2` receives `sigma_source: undefined → 'fallback'`, which triggers WI-0814 demotion of ALL playoff PLAYs to LEAN.

**Evidence:**
- `apps/worker/src/jobs/run_nhl_model.js:292-298` — `{...sigma, spread: sigma.spread * multiplier, total: sigma.total * multiplier}`
- `apps/worker/src/jobs/run_nba_model.js:342-349` — same pattern
- `packages/models/src/decision-pipeline-v2.js:1258-1263` — `jobSigmaSource = context?.sigmaOverride?.sigma_source ?? 'fallback'`
- No test file contains `applyPlayoffSigmaMultiplier` — confirmed via grep

**Required fix:**
Replace spread-and-overwrite with explicit field construction:
```javascript
return {
  ...sigma,                         // preserve sigma_source, games_sampled
  margin: sigma.margin != null ? sigma.margin * multiplier : sigma.margin,
  total: sigma.total != null ? sigma.total * multiplier : sigma.total,
  sigma_source: sigma.sigma_source, // EXPLICIT preservation
};
```
Drop the `spread` key entirely (it doesn't exist on real sigma objects).

**Tests required:**
- Unit: `applyPlayoffSigmaMultiplier({ margin:1.8, total:2.0, sigma_source:'computed', games_sampled:24 }, 1.1)` must return `{ margin: ~1.98, total: ~2.2, sigma_source: 'computed', games_sampled: 24 }`

---

### CF-009 — [MEDIUM] assertNoDecisionMutation Is console.warn-Only in Production

**Why it matters:**
`assertNoDecisionMutation()` is the final guard preventing post-publish field mutations. In production, it emits `console.warn` and continues. The decision state stored to DB may be corrupted. Downstream settlement, CLV, and performance attribution all read this data. A silent invariant breach is not detectable without log scraping.

**Evidence:**
- `apps/worker/src/utils/decision-publisher.js:178` — `if (context.throwOnViolation ?? process.env.NODE_ENV === 'test') { throw error; } else { console.warn(error.message); }`

**Required fix:**
Add Slack/Discord error channel alert for `INVARIANT_BREACH` in production, or escalate to job-level abort: `process.exitCode = 1; throw error`.

---

### CF-010 — [MEDIUM] computeSigmaFromHistory Swallows All DB Errors Silently

**Why it matters:**
A DB connection error in `computeSigmaFromHistory` is treated identically to "fewer than 20 games of history." The function returns `sigma_source: 'fallback'`. WI-0814 safety gate then demotes all PLAYs to LEAN for the entire run. The operator sees LEAN cards in the output but no error event. The root cause (DB failure) is invisible.

**Evidence:**
- `packages/models/src/edge-calculator.js:468-473` — `try { const rows = ... } catch (_err) { return fallback; }`

**Required fix:**
```javascript
} catch (err) {
  console.error('[computeSigmaFromHistory] DB error, falling back to static sigma:', err.message);
  // optionally: emitMetric('sigma_fallback_db_error', { sport, gameId, error: err.message });
  return { ...fallback, sigma_fallback_reason: 'db_error' };
}
```

---

## Guardrail Enforcement Matrix

| Guardrail | Where Defined | Where Enforced | Status | Bypass Path |
|-----------|---------------|----------------|--------|-------------|
| NO_BET blocks all cards | `input-gate.js` | `cross-market.js:921-926` (NBA), `cross-market.js:364-376` (NHL) | **PARTIAL** | NHL runner does not check `marketDecisions.status === 'NO_BET'` before downstream calls |
| DEGRADED caps confidence ≤ 0.55, blocks PLAY tier | `input-gate.js:DEGRADED_CONSTRAINTS` | `cross-market.js:844-848` (NHL), `cross-market.js:1200-1206` (NBA) | **ENFORCED** | None found |
| Watchdog BLOCKED → PASS | `decision-pipeline-v2.js` | `computeOfficialStatus:884` | **PARTIAL** | CAUTION does not block LEAN; 150-min threshold lets 2.5h-old odds through as CAUTION |
| Sigma fallback → LEAN cap | WI-0814, `decision-pipeline-v2.js` | `computeOfficialStatus:908` | **PARTIAL** | Playoff sigma path: `sigma_source` may be lost in a future refactor of `applyPlayoffSigmaMultiplier` |
| NBA total quarantine | `FLAGS.QUARANTINE_NBA_TOTAL` | `applyNbaTotalQuarantine` | **INACTIVE** | Flag defaults to `false`; quarantine is off by default unless env override |
| Edge sanity clamp (NHL ±18%) | WI-0815 | `edge-calculator.js:357-363` | **ENFORCED** | NBA totals with sigmaTotal ≥ 14 bypass clamp correctly |
| Play cleanliness: watchdog OK | `TARGETED_PLAY_CLEANLINESS_PROFILE` | `applyPlayCleanlinessCap` | **PARTIAL** | FIRST_PERIOD market excluded from profile; NHL SPREAD/PUCKLINE have no V2 threshold |
| Decision mutation invariant | `INVARIANT_BREACH` constant | `assertNoDecisionMutation` via `applyUiActionFields` | **PARTIAL** | Production: warn-only; execution gate mutation never checked |
| Single-writer DB contract | ADR-0002 | `packages/data/db.js`, `web/src/lib/db-init.ts` | **ENFORCED** | No violations found in core routes |
| Market calibration kill switch | `calibration-gate.js` | `execution-gate.js:76-82` | **ENFORCED** | None |
| Execution gate decision_v2 consistency | (none — absent) | (absent) | **MISSING** | Execution gate overwrites `action` but not `decision_v2.official_status` |

---

## Silent Failure Inventory

| File | Line | Trigger | Current Fallback | Why Dangerous |
|------|------|---------|------------------|---------------|
| `packages/models/src/edge-calculator.js` | ~470 | DB error in `computeSigmaFromHistory` | Returns static sigma fallback, no log | DB outage → all PLAYs downgraded to LEAN for entire run; operator sees LEAN cards, not errors |
| `apps/worker/src/jobs/run_nhl_model.js` | ~2239 | `computeNHLMarketDecisions()` returns `{status:'NO_BET'}` | 0 cards, `driversReady:false` in pipeline state | NO_BET indistinguishable from ESPN data failure in monitoring |
| `apps/worker/src/utils/decision-publisher.js` | ~178 | `assertNoDecisionMutation` detects post-publish mutation | `console.warn`, job continues | Corrupted decision state stored to DB, downstream reads bad data |
| `apps/worker/src/jobs/run_nhl_model.js` | ~519-529 | Execution gate blocks a card | Writes action=PASS, leaves `decision_v2.official_status=PLAY` | Settlement reads `decision_v2.official_status`, scores card as PLAY bet |
| `apps/worker/src/utils/decision-publisher.js` | ~32 | Wave1 card with `tier=GOOD/OK/BAD` | `deriveAction()` returns PASS silently | Valid signal suppressed with no log |
| `web/src/lib/game-card/transform/index.ts` | ~1929 | Stored PASS card with `edge > 0.02` | `derivePlayDecision()` returns BASE → card shown as FIRE | User sees FIRE recommendation the model rejected |
| `apps/worker/src/models/cross-market.js` | ~parseRawData | Invalid/null `raw_data` JSON | Returns `{}`, all ESPN metrics null | Game runs as DEGRADED silently; no explicit parse failure logged |
| `apps/worker/src/jobs/execution-gate.js` | ~48 | Card with missing `confidence` field | `hasConfidence=false`, confidence gate skipped | Card bypasses confidence gate entirely |

---

## Logic Duplication Inventory

| Concept | Source 1 | Source 2 | Risk |
|---------|----------|----------|------|
| **Edge thresholds** | `decision-pipeline-v2-edge-config.js:play_edge_min` (5-6.2%) | `web/src/lib/types/canonical-play.ts:THRESHOLDS.base_edge_threshold` (2-2.5%) | Web can re-promote PASS cards to FIRE |
| **Tier vocabulary** | `models/index.js:determineTier` (SUPER/BEST/WATCH/null) | `decision-pipeline-v2.js:derivePlayTierWithThresholds` (BEST/GOOD/OK/BAD) | GOOD/OK/BAD fall through `deriveAction` to PASS |
| **NBA projection formula** | `projections.js:projectNBA` (deprecated, multiplicative pace) | `projections.js:projectNBACanonical + analyzePaceSynergy` (additive pace) | Driver cards and market-call cards may project opposing sides |
| **Decision status mapping** | `decision-publisher.js:mapOfficialStatusToLegacyDecision` (PLAY→FIRE) | `decision-publisher.js:deriveAction` (tier→FIRE) | Three different code paths map to FIRE FIRE |
| **Stale snapshot check** | `decision-pipeline-v2.js:STALE_BLOCK_THRESHOLD_MINUTES=150` | `execution-gate.js:MAX_SNAPSHOT_AGE_MS=5min` | Decision pipeline far more permissive than execution gate |
| **PASS detection** | `post_discord_cards.js:isNonPassCard` checks `action` | `post_discord_cards.js:classifyDecisionBucket` checks both `action` and `pass_reason` | Two patterns; inconsistent dedup |
| **Play-side validation** | `decision-pipeline-v2.js:sideValidForMarket` | `web/src/lib/play-decision/decision-logic.ts:isMarketTypeSupportedForSport` | Different scope; a side blocked by backend may be accepted by web |

---

## Data Contract Weaknesses

| Module Boundary | Contract Issue | Risk Level |
|----------------|---------------|-----------|
| `computeNHLMarketDecisions` → `run_nhl_model.js` | Return may be `{status:'NO_BET'}` (no market keys) OR `{TOTAL, SPREAD, ML}`. Caller has no contract check on `.status`. | **Critical** |
| `publishDecisionForCard` → `applyExecutionGateToNhlCard` | `decision_v2.official_status` written by first, overwritten by second for `action` only — contract that they agree is unenforceable | **Critical** |
| `computeSigmaFromHistory` → `applyPlayoffSigmaMultiplier` | Sigma shape is `{margin, total, sigma_source}`. Multiplier spreads and overwrites `spread` (non-existent key) and `total`. No contract test. | **High** |
| `execution-gate.js:evaluateExecution` | `payload.edge` used as `rawEdge`. Wave1 cards store edge in `decision_v2.edge_pct` not `payload.edge`. Gate may receive null rawEdge for any wave1 card and emit NO_EDGE_COMPUTED block. | **High** |
| `settle_pending_cards.js` | Reads `decision_v2.official_status` as primary, falls back to `payload.status` field mapping. When execution gate has set `action=PASS` but not `decision_v2.official_status`, settlement resolves to PLAY. | **Critical** |
| `DEGRADED_CONSTRAINTS.FORBIDDEN_TIERS` | Contains `'PLAY'` but cross-checked against `best_candidate.tier` using legacy vocabulary — if tier is `'FIRE'`, not `'PLAY'`, the forbidden check passes. | **Medium** |
| `card_payloads.decision_v2` | Schema allows `decision_v2.official_status=PLAY` and top-level `action=PASS` simultaneously. No DB constraint enforces consistency. | **Critical** |

---

## Testing Gaps

| Priority | Missing Test | File to Create or Update |
|----------|-------------|--------------------------|
| **Critical** | Web transform: card with `decision_v2.official_status=PASS` and `edge=0.04` must not surface as FIRE | `web/src/__tests__/game-card-transform-market-contract.test.ts` |
| **Critical** | Execution gate blocked card: `decision_v2.official_status` must be PASS after gate fires | `apps/worker/src/jobs/__tests__/execution-gate-decision-consistency.test.js` |
| **Critical** | Settlement does not score gate-blocked card as PLAY | `apps/worker/src/jobs/__tests__/settle_pending_cards.gate-blocked.test.js` |
| **High** | `run_nhl_model`: DOUBLE_UNKNOWN_GOALIE → `gamePipelineStates[gameId].blockingReasonCodes` includes `'DOUBLE_UNKNOWN_GOALIE'` | `apps/worker/src/jobs/__tests__/run_nhl_model.no-bet.test.js` |
| **High** | `deriveAction({ tier: 'GOOD' })` returns `'HOLD'`, not `'PASS'` | `apps/worker/src/utils/__tests__/decision-publisher.tier-vocab.test.js` |
| **High** | `applyPlayoffSigmaMultiplier` — output contains `sigma_source` from input | `apps/worker/src/jobs/__tests__/run_nhl_model.playoff-sigma.test.js` |
| **High** | `shouldFlip()` returns `true` when `edgeDelta=0.04` | `packages/models/src/__tests__/decision-gate.flip-threshold.test.js` |
| **High** | `computeSigmaFromHistory` DB error → returns fallback AND logs error (check log output) | `packages/models/src/__tests__/edge-calculator.sigma-db-error.test.js` |
| **Medium** | Watchdog CAUTION (90-min-old snapshot) with threshold=30 → `official_status=PASS` not LEAN | `packages/models/src/__tests__/decision-pipeline-v2-stale-odds.test.js` |
| **Medium** | `computeNBADriverCards` and `computeNBAMarketDecisions` with same input → projections within ±2 pts | `apps/worker/src/__tests__/nba-projection-parity.test.js` |
| **Medium** | Execution gate: wave1 card with `decision_v2.edge_pct=0.06` but `payload.edge=null` → gate uses `decision_v2.edge_pct` | `apps/worker/src/jobs/__tests__/execution-gate-wave1-edge.test.js` |

---

## Spec Drift

| Expected Behavior | Documented In | Actual Behavior | Drift Location |
|------------------|---------------|-----------------|----------------|
| Stale threshold = 30 min | `decision-pipeline-v2.js` comment (TODO) | Actually 150 min | `decision-pipeline-v2.js:1120` |
| NBA total quarantine active | WI-0588 | `QUARANTINE_NBA_TOTAL` defaults to `false`; quarantine is OFF unless env overrides | `packages/models/src/flags.js:17` |
| `computeNBAMarketDecisions` uses canonical projection | WI-0822 | Canonical: ✓. but `computeNBADriverCards` (same run) still uses deprecated `projectNBA` | `apps/worker/src/models/index.js:1499` |
| `EDGE_UPGRADE_MIN` calibrated to market conditions | (no ADR) | Set to 0.5 (50pp); permanently blocks all flips | `packages/models/src/decision-gate.js:29` |
| Decision field mutations halt job | Implied by `assertNoDecisionMutation` naming | Production: warn-only, continues | `apps/worker/src/utils/decision-publisher.js:178` |
| NHL SPREAD market uses NHL-calibrated thresholds | Implied by `ENABLE_MARKET_THRESHOLDS_V2=true` | No NHL:SPREAD entry in `SPORT_MARKET_THRESHOLDS_V2` → falls to generic default | `packages/models/src/decision-pipeline-v2-edge-config.js:43-63` |
| Backend decision is authoritative | Implied by `buildDecisionV2` | Web `derivePlayDecision` re-derives with different thresholds | `web/src/lib/play-decision/decision-logic.ts:183` |

---

## Hardening Plan

### Immediate (before next game-day run)

| ID | Action | Files | Invariant |
|----|--------|-------|-----------|
| H-001 | Add `if (marketDecisions?.status === 'NO_BET') { ... continue; }` after `computeNHLMarketDecisions()` | `apps/worker/src/jobs/run_nhl_model.js:2240` | NO_BET must write pipeline state and never fall through to card generation |
| H-002 | Execution gate must run BEFORE `publishDecisionForCard` OR must update `decision_v2.official_status` when blocking | `run_nhl_model.js:2428-2457`, `run_nba_model.js` | `action` and `decision_v2.official_status` must agree in stored payload |
| H-003 | Log DB error in `computeSigmaFromHistory` catch block before returning fallback | `packages/models/src/edge-calculator.js:470` | DB errors must be observable; sigma fallback_reason must distinguish `db_error` from `insufficient_history` |
| H-004 | `applyPlayoffSigmaMultiplier` must explicitly copy `sigma_source` in return object | `run_nhl_model.js:292`, `run_nba_model.js:342` | `sigma_source` must survive playoff multiplier application |

### Short-Term (this sprint)

| ID | Action | Files | Invariant |
|----|--------|-------|-----------|
| H-005 | Web transform: add guard to skip `derivePlayDecision` when `decision_v2.official_status` is present | `web/src/lib/game-card/transform/index.ts:1929` | Backend `decision_v2.official_status` is sole classification authority |
| H-006 | Unify tier vocabulary: add GOOD/OK/BAD mappings to `deriveAction()`; add GOOD/OK/BAD to web `TIER_SCORE` | `decision-publisher.js:32-36`, `transform/index.ts:88` | GOOD-tier cards must get HOLD action, not PASS |
| H-007 | Replace `STALE_BLOCK_THRESHOLD_MINUTES = 150` with env var defaulting to 30 | `decision-pipeline-v2.js:1120` | Stale threshold must be configurable and default to 30 min |
| H-008 | `assertNoDecisionMutation` must emit to error channel (not just console.warn) in production | `decision-publisher.js:178` | Invariant breach must be observable in production |
| H-009 | Settlement: when `action=PASS` AND `decision_v2.official_status=PLAY`, log INVARIANT_BREACH and skip card | `settle_pending_cards.js:612` | Gate-blocked cards must never be scored as tracked bets |

### Medium-Term (next sprint)

| ID | Action | Files | Invariant |
|----|--------|-------|-----------|
| H-010 | Complete `projectNBA → projectNBACanonical` migration in `computeNBADriverCards` | `apps/worker/src/models/index.js:1499` | Only one NBA projection formula should be active in production |
| H-011 | Calibrate or explicitly disable `EDGE_UPGRADE_MIN` | `decision-gate.js:29` | Flip mechanism must either be functional or explicitly documented as disabled |
| H-012 | Add NHL:SPREAD and NHL:PUCKLINE entries to `SPORT_MARKET_THRESHOLDS_V2` | `decision-pipeline-v2-edge-config.js:43-63` | NHL spread/puckline must use NHL-calibrated thresholds, not NBA defaults |
| H-013 | Re-evaluate and document NBA sigma defaults (`margin=12, total=14`) | `edge-calculator.js:getSigmaDefaults()` | Defaults must have documented empirical basis or be replaced with calibrated values |
| H-014 | Add ADR: "Backend decision is authoritative; web reads decision_v2.official_status only" | `docs/decisions/ADR-XXXX.md` | Single source of truth must be documented |

---

## Top 10 Killshots

Ranked from most dangerous to least.

**#1 — Web re-derives PASS cards as FIRE using 3x lower threshold.**
File: `web/src/lib/game-card/transform/index.ts:1929` + `decision-logic.ts:183` + `canonical-play.ts:280`
A valid PASS recommendation becomes FIRE for end users. Users bet on picks the model deliberately rejected.

**#2 — Execution gate creates payload inconsistency: decision_v2.official_status=PLAY + action=PASS.**
File: `run_nhl_model.js:2457` + `settle_pending_cards.js:612`
Settlement scores gate-blocked cards as tracked bets. Performance metrics and CLV calculations include ghost picks that were never shown to users.

**#3 — Stale odds threshold stuck at 150 min (2.5 h) with acknowledged TODO to restore 30 min.**
File: `decision-pipeline-v2.js:1120`
LEAN cards can be generated from 2.5-hour-old lines. Market may have moved 2-3% in that time. Stale edge is not real edge.

**#4 — Dual NBA projection formulas produce opposing side signals for the same game.**
File: `models/index.js:1499` (deprecated `projectNBA`) + `cross-market.js` (canonical `projectNBACanonical`)
Driver card fires OVER; market-call card fires UNDER. Deduplication is order-dependent, not signal-based. Users may see the wrong direction.

**#5 — EDGE_UPGRADE_MIN = 0.5 makes flip mechanism permanently inoperative.**
File: `decision-gate.js:29`
The system cannot self-correct side selection under any realistic operating conditions. A wrong initial side is locked in forever.

**#6 — NHL NO_BET (DOUBLE_UNKNOWN_GOALIE) is silent: zero cards, no pipeline state.**
File: `run_nhl_model.js:2239-2257`
Monitoring shows `driversReady:false`, identical to data failure. Operators cannot distinguish a valid NO_BET from a broken ESPN feed. Incident response is misdirected.

**#7 — Tier vocabulary split: `deriveAction` maps GOOD/OK/BAD → PASS silently.**
File: `decision-publisher.js:32-36`
Valid signals above threshold but using the wave1 vocabulary are silently suppressed. Users never see them. Model appears less active than it actually is.

**#8 — DB error in computeSigmaFromHistory → entire run degrades to LEAN with no alert.**
File: `edge-calculator.js:470`
Temporary DB unavailability causes WI-0814 safety gate to fire for all games, demoting all PLAYs to LEAN. No error surface. Operator investigation starts from wrong premise.

**#9 — assertNoDecisionMutation is console.warn-only in production.**
File: `decision-publisher.js:178`
Post-publish invariant breaches write corrupted state to DB and continue without any alert. Downstream settlement and scoring read bad data silently.

**#10 — NHL SPREAD/PUCKLINE use NBA-generic thresholds (no V2 profile entry).**
File: `decision-pipeline-v2-edge-config.js:43-63`
With `ENABLE_MARKET_THRESHOLDS_V2=true` (default), NHL SPREAD and PUCKLINE markets fall through to the generic 6% default. NHL and NBA have fundamentally different line structures; NHL spread requires different calibration.
