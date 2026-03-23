---
phase: quick-68
plan: 01
type: execute
wave: 1
depends_on: []
files_modified:
  - packages/models/src/edge-calculator.js
  - packages/models/src/decision-gate.js
  - packages/models/src/decision-pipeline-v2.js
  - web/src/app/api/games/route.ts
  - apps/worker/src/utils/decision-publisher.js
  - apps/worker/src/jobs/run_nhl_model.js
autonomous: true
requirements: [AUDIT-FIX-01, AUDIT-FIX-02, AUDIT-FIX-03, AUDIT-FIX-04, AUDIT-FIX-05, AUDIT-FIX-06]

must_haves:
  truths:
    - "NHL OVER edge for a 5.5 or 6.5 total reflects real probability — no phantom +0.5 line inflation"
    - "buildDecisionV2 catch block logs error.message + stack before returning synthetic BLOCKED"
    - "truePlayMap for a game holds the highest-tier (PLAY > LEAN) + highest-edge candidate, not the chronologically first"
    - "edgeDelta is null whenever candidate.edge or current.edge is not a finite number, regardless of edge_available flag"
    - "reason_codes on a PLAY card contains only the current primary_reason_code after each pipeline run"
    - "EVIDENCE cards written by run_nhl_model.js carry reason_codes = [pass_reason_code], not a stale accumulated set"
  artifacts:
    - path: packages/models/src/edge-calculator.js
      provides: "Integer-only +0.5 continuity correction"
      contains: "lineIsInteger"
    - path: packages/models/src/decision-gate.js
      provides: "Null-safe edgeDelta using hasFiniteEdge guard"
      contains: "hasFiniteEdge"
    - path: packages/models/src/decision-pipeline-v2.js
      provides: "Logging catch block + PLAY-priority truePlayMap replacement"
      contains: "[buildDecisionV2] PARSE_FAILURE"
    - path: web/src/app/api/games/route.ts
      provides: "officialTier comparison replacing first-come truePlayMap.has early-exit"
    - path: apps/worker/src/utils/decision-publisher.js
      provides: "reason_codes replace (not merge) on each pipeline run"
    - path: apps/worker/src/jobs/run_nhl_model.js
      provides: "reason_codes = [pass_reason_code] written alongside pass_reason_code on EVIDENCE cards"
  key_links:
    - from: packages/models/src/edge-calculator.js
      to: "NHL OVER probability"
      via: "lineIsInteger guard before adjustedLine assignment"
      pattern: "lineIsInteger"
    - from: apps/worker/src/utils/decision-publisher.js
      to: "payload.reason_codes"
      via: "Array.from(new Set([decisionV2.primary_reason_code].filter(Boolean)))"
---

<objective>
Apply all six Tier 0 audit-derived fixes from WI-0572 hostile audit. All fixes target existing files — no new files are created.

Purpose: Two CRITICAL and four HIGH defects silently degrade edge accuracy, mask pipeline errors, and corrupt card metadata in production. These must be resolved before any Tier 1 work.

Output: Six targeted code changes across five files. Existing tests updated where fix changes previously-asserted (now incorrect) behaviour.
</objective>

<execution_context>
@/Users/ajcolubiale/.claude/get-shit-done/workflows/execute-plan.md
@/Users/ajcolubiale/.claude/get-shit-done/templates/summary.md
</execution_context>

<context>
@.planning/STATE.md

Source files being modified:
- packages/models/src/edge-calculator.js
- packages/models/src/decision-pipeline-v2.js  (~L1342 catch block, ~L3151 truePlayMap loop — note: truePlayMap loop is in web/src/app/api/games/route.ts not decision-pipeline-v2.js)
- packages/models/src/decision-gate.js
- apps/worker/src/utils/decision-publisher.js
- apps/worker/src/jobs/run_nhl_model.js

Tests to be aware of:
- packages/models/src/__tests__/edge-calculator.test.js (NHL half-integer total assertions may need updating)
- apps/worker/src/jobs/__tests__/run_nhl_model.test.js (reason_codes accumulation assertions)
</context>

<tasks>

<task type="auto" tdd="true">
  <name>Task 1: Fix NHL edge math — integer-only continuity correction (AUDIT-FIX-01) + null-safe edgeDelta (AUDIT-FIX-04)</name>
  <files>packages/models/src/edge-calculator.js, packages/models/src/decision-gate.js, packages/models/src/__tests__/edge-calculator.test.js</files>
  <behavior>
    - edge-calculator: computeTotalEdge with sigmaTotal=1.8, totalLine=5.5 — adjustedLine must equal 5.5 (no +0.5), not 6.0
    - edge-calculator: computeTotalEdge with sigmaTotal=1.8, totalLine=6 (integer) — adjustedLine must equal 6.5 (old behaviour preserved)
    - decision-gate: shouldFlip with candidate.edge=null, candidate.edge_available=true — edgeDelta must be null (not 0), should NOT fire EDGE_UPGRADE
    - decision-gate: shouldFlip with candidate.edge=0.04, current.edge=0.01, both edge_available=true — edgeDelta must be 0.03
  </behavior>
  <action>
    AUDIT-FIX-01 — packages/models/src/edge-calculator.js ~L259:

    Replace the single line:
      const adjustedLine = isNhlStyleTotal ? L + 0.5 : L;

    With:
      // Only apply continuity correction for integer lines (e.g., line=6 → 6.5).
      // Half-integer NHL lines (e.g., 5.5, 6.5) already sit between integers — no adjustment needed.
      const lineIsInteger = L % 1 === 0;
      const adjustedLine = (isNhlStyleTotal && lineIsInteger) ? L + 0.5 : L;

    Update packages/models/src/__tests__/edge-calculator.test.js: if any test fixture uses sigmaTotal <= 3 with a half-integer totalLine (e.g., 5.5) and asserts a specific p_fair or edge value that was computed with the old +0.5 adjustment, recalculate and update those assertions to reflect the corrected (no +0.5) probability. Integer-line NHL fixtures remain unchanged.

    AUDIT-FIX-04 — packages/models/src/decision-gate.js ~L240–L273:

    The variable `edgeComparable` is defined at L240 as:
      const edgeComparable = candidateEdgeAvailable && currentEdgeAvailable;

    The bug is that even when edgeComparable is true, `candidate.edge ?? 0` coerces a null edge to 0.

    Replace every occurrence of `(candidate.edge ?? 0) - (current.edge ?? 0)` where edgeDelta is computed (L258 inside CRITICAL_OVERRIDE block, L272 in the main edgeDelta assignment) with a guard that checks actual finiteness:

    Add a local helper (or reuse existing hasFiniteEdge if already present — grep the file first):
      const hasFiniteEdge = (e) => typeof e === 'number' && Number.isFinite(e);

    Then replace L271–L273:
      const edgeDelta = (hasFiniteEdge(candidate?.edge) && hasFiniteEdge(current?.edge))
        ? candidate.edge - current.edge
        : null;

    And replace L257–L259 (CRITICAL_OVERRIDE block):
      edge_delta: (hasFiniteEdge(candidate?.edge) && hasFiniteEdge(current?.edge))
        ? candidate.edge - current.edge
        : null,

    If hasFiniteEdge is already defined elsewhere in decision-gate.js, do not redefine it — use the existing function. Grep first.
  </action>
  <verify>
    <automated>cd /Users/ajcolubiale/projects/cheddar-logic && node --experimental-vm-modules node_modules/.bin/jest packages/models/src/__tests__/edge-calculator.test.js --no-coverage 2>&1 | tail -20</automated>
  </verify>
  <done>
    Jest exits 0 for edge-calculator tests. NHL half-integer total tests (sigmaTotal &lt;= 3, non-integer line) assert unadjusted probability. Integer NHL total tests still apply +0.5. decision-gate hasFiniteEdge guard in place — null edge produces null edgeDelta regardless of edge_available flag.
  </done>
</task>

<task type="auto">
  <name>Task 2: Log PARSE_FAILURE in buildDecisionV2 catch (AUDIT-FIX-02) + PLAY-priority truePlayMap replacement (AUDIT-FIX-03)</name>
  <files>packages/models/src/decision-pipeline-v2.js, web/src/app/api/games/route.ts</files>
  <action>
    AUDIT-FIX-02 — packages/models/src/decision-pipeline-v2.js ~L1342:

    The current catch block (around L1342) starts with `} catch (error) {` and immediately builds the synthetic BLOCKED return object. Add a console.error call as the first statement inside the catch block, before the return:

      } catch (error) {
        console.error('[buildDecisionV2] PARSE_FAILURE — returning synthetic BLOCKED result', {
          error: error instanceof Error ? { message: error.message, stack: error.stack } : error,
          sport: payload?.sport,
          market_type: payload?.market_type,
          game_id: payload?.game_id,
        });
        return {
          // ... existing return object unchanged ...

    Do not modify the return object contents — only add the console.error before it.

    AUDIT-FIX-03 — web/src/app/api/games/route.ts ~L3151:

    The current loop body (around L3148–L3168) contains:
      if (truePlayMap.has(canonicalGameId)) continue;

    This early-exit means the first chronological play for a game wins, even if it is a LEAN and a later PLAY exists.

    Replace the truePlayMap population section. The current code around L3148–L3168 should become:

      for (const displayLogRow of displayLogRows) {
        const canonicalGameId =
          externalToCanonicalMap.get(displayLogRow.game_id) ?? displayLogRow.game_id;
        const candidate = playByCardId.get(displayLogRow.pick_id);
        if (!candidate) continue;
        if ((candidate.kind ?? 'PLAY') !== 'PLAY') continue;
        const officialStatus =
          candidate.decision_v2?.official_status ??
          (candidate.action === 'FIRE'
            ? 'PLAY'
            : candidate.action === 'HOLD'
              ? 'LEAN'
              : candidate.status === 'FIRE'
                ? 'PLAY'
                : candidate.status === 'WATCH'
                  ? 'LEAN'
                  : 'PASS');
        if (officialStatus !== 'PLAY' && officialStatus !== 'LEAN') continue;

        // officialTier: PLAY=2, LEAN=1, other=0
        const officialTier = officialStatus === 'PLAY' ? 2 : officialStatus === 'LEAN' ? 1 : 0;

        const existing = truePlayMap.get(canonicalGameId);
        if (existing) {
          const existingStatus =
            existing.decision_v2?.official_status ??
            (existing.action === 'FIRE'
              ? 'PLAY'
              : existing.action === 'HOLD'
                ? 'LEAN'
                : existing.status === 'FIRE'
                  ? 'PLAY'
                  : existing.status === 'WATCH'
                    ? 'LEAN'
                    : 'PASS');
          const existingTier = existingStatus === 'PLAY' ? 2 : existingStatus === 'LEAN' ? 1 : 0;
          // Only replace if candidate is strictly better tier, or same tier with higher edge
          const candidateEdge = candidate.decision_v2?.edge_pct ?? candidate.edge ?? -Infinity;
          const existingEdge = existing.decision_v2?.edge_pct ?? existing.edge ?? -Infinity;
          if (officialTier < existingTier) continue;
          if (officialTier === existingTier && candidateEdge <= existingEdge) continue;
        }
        truePlayMap.set(canonicalGameId, candidate);
      }

    Note: the `perf.cardsParseMs` assignment and surrounding for-loop structure must be preserved — only the inner body of the displayLogRows loop changes.
  </action>
  <verify>
    <automated>cd /Users/ajcolubiale/projects/cheddar-logic && npx tsc --noEmit -p web/tsconfig.json 2>&1 | tail -20</automated>
  </verify>
  <done>
    tsc exits 0. The catch block in buildDecisionV2 emits console.error with error.message, stack, sport, market_type, game_id before returning. The truePlayMap loop no longer short-circuits on first-seen — a PLAY always beats a LEAN for the same game; ties broken by edge_pct descending.
  </done>
</task>

<task type="auto">
  <name>Task 3: Replace reason_codes (not merge) in decision-publisher (AUDIT-FIX-05) + sync reason_codes on EVIDENCE cards in run_nhl_model (AUDIT-FIX-06)</name>
  <files>apps/worker/src/utils/decision-publisher.js, apps/worker/src/jobs/run_nhl_model.js, apps/worker/src/jobs/__tests__/run_nhl_model.test.js</files>
  <action>
    AUDIT-FIX-05 — apps/worker/src/utils/decision-publisher.js ~L158:

    The current code merges reason_codes:
      payload.reason_codes = Array.from(
        new Set([
          ...(Array.isArray(payload.reason_codes) ? payload.reason_codes : []),
          decisionV2.primary_reason_code,
        ]),
      );

    Replace with a replace (not merge):
      // Replace — do not accumulate. Only keep the current primary reason code.
      payload.reason_codes = Array.from(
        new Set([decisionV2.primary_reason_code].filter(Boolean))
      );

    This is inside the `if (decisionV2)` block in `applyUiActionFields`. The surrounding code (setting payload.decision_v2, payload.classification, payload.action, payload.status, payload.pass_reason_code) must remain unchanged.

    AUDIT-FIX-06 — apps/worker/src/jobs/run_nhl_model.js:

    Find the block where `pass_reason_code` is written on EVIDENCE cards (the block added in commit 9f59c8e, around the `if (!isPlayable && !payload.pass_reason_code)` guard at approximately L401–L409). After the `payload.pass_reason_code = ...` assignment, add the reason_codes sync immediately:

      payload.pass_reason_code =
        sidePrice === null
          ? 'FIRST_PERIOD_NO_PROJECTION'
          : 'SUPPORT_BELOW_LEAN_THRESHOLD';
      // Sync reason_codes so EVIDENCE cards don't carry stale accumulated codes (AUDIT-FIX-06)
      payload.reason_codes = [payload.pass_reason_code].filter(Boolean);

    Update apps/worker/src/jobs/__tests__/run_nhl_model.test.js: if any test asserts that reason_codes contains more than one code (accumulation behaviour), or asserts toContain with an old stale code alongside a new one, update those assertions to reflect that reason_codes is now a single-element array containing only the current primary_reason_code. Tests asserting the presence of the current code remain valid.
  </action>
  <verify>
    <automated>cd /Users/ajcolubiale/projects/cheddar-logic && node --experimental-vm-modules node_modules/.bin/jest apps/worker/src/jobs/__tests__/run_nhl_model.test.js --no-coverage 2>&1 | tail -20</automated>
  </verify>
  <done>
    Jest exits 0. decision-publisher.js reason_codes assignment is a replacement (single Set from primary_reason_code only). run_nhl_model.js EVIDENCE card path sets reason_codes = [pass_reason_code] immediately after setting pass_reason_code. No test asserts stale multi-code accumulation.
  </done>
</task>

</tasks>

<verification>
Run full model package test suite after all three tasks complete:

  cd /Users/ajcolubiale/projects/cheddar-logic && node --experimental-vm-modules node_modules/.bin/jest packages/models --no-coverage 2>&1 | tail -30

Then run lint and TS check:

  cd /Users/ajcolubiale/projects/cheddar-logic && npm run lint 2>&1 | tail -20
  cd /Users/ajcolubiale/projects/cheddar-logic && npx tsc --noEmit 2>&1 | tail -20
</verification>

<success_criteria>
- All six audit fixes implemented as specified (no phantom +0.5 for NHL half-integer lines, error logged before BLOCKED synthetic return, truePlayMap prefers PLAY over LEAN, edgeDelta is null when edge is non-finite, reason_codes replaced not merged, EVIDENCE cards carry reason_codes = [pass_reason_code])
- All pre-existing tests pass (updated where fix changes previously-asserted incorrect behavior)
- tsc --noEmit exits 0
- npm run lint exits 0
</success_criteria>

<output>
After completion, create `.planning/quick/68-tier-0-audit-derived-fixes-audit-fix-01-/68-SUMMARY.md` following the summary template.
</output>
