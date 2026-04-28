---
phase: WI-1200
verified: 2026-04-28T01:29:55Z
status: gaps_found
score: 1/7 must-haves verified
re_verification:
  previous_status: gaps_found
  previous_score: 1/7
  gaps_closed: []
  gaps_remaining:
    - "Web cards/games/results are not wired to buildDecisionOutcomeFromDecisionV2"
    - "Parity tests for cards/games/results DecisionOutcome are still missing"
    - "Web still contains local decision mapping/reinterpretation paths"
    - "DecisionOutcome reasons.blockers are not surfaced"
    - "Existing cards smoke regression is still failing"
  regressions: []
gaps:
  - truth: "Web cards, games, and results API surfaces use WI-1199 canonical builder as single source of truth"
    status: failed
    reason: "No web import/call sites for buildDecisionOutcomeFromDecisionV2; scoped routes still use local status extraction and runtime authority mapping."
    artifacts:
      - path: "web/src/app/api/cards/route.ts"
        issue: "Local readProjectionOfficialStatus/normalizeLegacyProjectionStatus logic instead of canonical builder"
      - path: "web/src/lib/games/route-handler.ts"
        issue: "Uses readRuntimeCanonicalDecision path; no canonical builder import"
      - path: "web/src/app/api/results/projection-metrics.ts"
        issue: "Derives actionable status from payload fields and fallback status, not DecisionOutcome"
    missing:
      - "Import buildDecisionOutcomeFromDecisionV2 from @cheddar-logic/data in scoped web read boundaries"
      - "Replace local status extraction/recompute paths with canonical DecisionOutcome consumption"
  - truth: "Parity coverage exists for cards/games/results decision outcome behavior (50+ fixtures each scope)"
    status: failed
    reason: "Expected WI-1200 parity test files are absent."
    artifacts:
      - path: "web/src/__tests__/cards-decision-outcome-parity.test.ts"
        issue: "Missing"
      - path: "web/src/__tests__/games-decision-outcome-parity.test.ts"
        issue: "Missing"
      - path: "web/src/__tests__/results-decision-outcome-parity.test.ts"
        issue: "Missing"
    missing:
      - "Add cards/games/results parity suites asserting status/count/presentation parity against prior behavior"
      - "Meet fixture volume target (50+ decisions per parity surface)"
  - truth: "Web does not implement local decision_v2 -> outcome mappers"
    status: failed
    reason: "Web code still contains local status interpretation and conversion helpers instead of shared DecisionOutcome mapping."
    artifacts:
      - path: "web/src/lib/runtime-decision-authority.ts"
        issue: "Maps canonical status/action/classification/status locally"
      - path: "web/src/app/api/cards/route.ts"
        issue: "Local readProjectionOfficialStatus path with legacy status fallback"
    missing:
      - "Route all decision mapping through WI-1199 canonical builder outputs"
      - "Remove or bypass local mapping logic in scoped surfaces"
  - truth: "DecisionOutcome reasons.blockers are surfaced in web behavior"
    status: failed
    reason: "No usage sites found for DecisionOutcome.reasons.blockers in web scoped paths."
    artifacts:
      - path: "web/src/lib/game-card/decision.ts"
        issue: "Consumes action/status only; no blocker list plumbing"
      - path: "web/src/lib/results/transform-layer.ts"
        issue: "Segments by status only; no blocker-reason surfacing"
    missing:
      - "Plumb DecisionOutcome.reasons.blockers from API boundary into card/results surfaces"
      - "Add assertions that blocker reasons appear where expected"
  - truth: "Existing cards/games/results regressions remain green after WI-1200 wiring"
    status: failed
    reason: "Representative existing cards test currently fails."
    artifacts:
      - path: "web/src/__tests__/ui-cards-smoke.test.js"
        issue: "Fails with: projections mode should use the canonical card predicate contract"
    missing:
      - "Fix failing cards regression in current branch context"
      - "Re-run cards/games/results baseline suite after canonical builder wiring"
---

# Phase WI-1200: Wire Web to DecisionOutcome Re-Verification Report

**Phase Goal:** Refactor web cards/games/results surfaces to consume DecisionOutcome as the single source of truth via canonical builder, with parity to prior behavior.
**Verified:** 2026-04-28T01:29:55Z
**Status:** gaps_found
**Re-verification:** Yes - after prior gaps review

## Goal Achievement

### Observable Truths

| # | Truth | Status | Evidence |
| --- | --- | --- | --- |
| 1 | Web API surfaces call canonical DecisionOutcome builder from shared package | ✗ FAILED | No `buildDecisionOutcomeFromDecisionV2` usage found in `web/src`; cards/games/results paths still use local logic |
| 2 | Cards/games/results parity tests exist for decision outcome behavior | ✗ FAILED | No parity files matching `*decision-outcome-parity*` in `web/src/__tests__` |
| 3 | Web has no local decision mapper implementations | ✗ FAILED | Local mapper/normalizer logic still present in runtime decision authority and cards route helpers |
| 4 | PLAY/PASS rendering semantics flow directly from canonical DecisionOutcome without reinterpretation | ✗ FAILED | Cards and projection-metrics still implement local status interpretation/fallback logic |
| 5 | Blocker reasons from DecisionOutcome are surfaced | ✗ FAILED | No blocker plumbing/usage found (`reasons.blockers` not referenced in web src) |
| 6 | Existing cards/games/results behavior remains green | ✗ FAILED | `test:ui:cards` still fails; games and results representative tests pass |
| 7 | Web strict typecheck passes cleanly | ✓ VERIFIED | `npm --prefix web run typecheck` passed again |

**Score:** 1/7 truths verified

### Required Artifacts

| Artifact | Expected | Status | Details |
| --- | --- | --- | --- |
| `web/src/lib/game-card/decision.ts` | Consume canonical DecisionOutcome builder output | ⚠️ ORPHANED_EQUIVALENT | Uses runtime decision authority adapter, not WI-1199 builder |
| `web/src/lib/game-card/transform/index.ts` | Consume DecisionOutcome only (no local recompute) | ⚠️ ORPHANED_EQUIVALENT | Still coupled to local decision helpers; no DecisionOutcome object flow |
| `web/src/app/api/cards/route.ts` | Apply canonical builder and serialize DecisionOutcome | ✗ FAILED | Still uses `readProjectionOfficialStatus` + legacy fallback logic |
| `web/src/app/api/games/route.ts` | Apply canonical builder in games path | ⚠️ PARTIAL | Re-export only; actual handler in `web/src/lib/games/route-handler.ts` still uses runtime authority/local logic |
| `web/src/app/api/results/projection-metrics.ts` | Builder then outcome-driven metrics | ✗ FAILED | Still derives status/actionability from payload + fallback fields |
| `web/src/__tests__/cards-decision-outcome-parity.test.ts` | New parity suite | ✗ MISSING | Not present |
| `web/src/__tests__/games-decision-outcome-parity.test.ts` | New parity suite | ✗ MISSING | Not present |
| `web/src/__tests__/results-decision-outcome-parity.test.ts` | New parity suite | ✗ MISSING | Not present |

### Key Link Verification

| From | To | Via | Status | Details |
| --- | --- | --- | --- | --- |
| `web/src/app/api/cards/route.ts` | `@cheddar-logic/data.buildDecisionOutcomeFromDecisionV2` | import + call | ✗ NOT_WIRED | No builder import/call; local `readProjectionOfficialStatus` path remains |
| `web/src/lib/games/route-handler.ts` | `@cheddar-logic/data.buildDecisionOutcomeFromDecisionV2` | import + call | ✗ NOT_WIRED | Still uses `readRuntimeCanonicalDecision` |
| `web/src/app/api/results/projection-metrics.ts` | `@cheddar-logic/data.buildDecisionOutcomeFromDecisionV2` | import + call | ✗ NOT_WIRED | Status still derived from payload fields/fallbacks |
| `web/src/lib/game-card/decision.ts` | canonical decision source | `readRuntimeCanonicalDecision(...)` | ⚠️ PARTIAL | Wired to canonical authority model path, but still not WI-1199 DecisionOutcome builder contract |
| parity tests | scoped surfaces | fixture-based status/count/presentation assertions | ✗ NOT_WIRED | Test artifacts still absent |

### Requirements Coverage

| Requirement | Source Plan | Description | Status | Evidence |
| --- | --- | --- | --- | --- |
| WI-1200 acceptance: all scoped routes call canonical builder | `WORK_QUEUE/WI-1200.md` | No local mapping, shared builder only | ✗ BLOCKED | No builder usage in scoped web files |
| WI-1200 acceptance: parity tests (50+ fixtures) | `WORK_QUEUE/WI-1200.md` | cards/games/results parity suites | ✗ BLOCKED | Expected parity files still missing |
| WI-1200 acceptance: no web-local mapper | `WORK_QUEUE/WI-1200.md` | Shared mapper only | ✗ BLOCKED | Local status mapping still present |
| WI-1200 acceptance: blockers surfaced | `WORK_QUEUE/WI-1200.md` | reasons.blockers visible | ✗ BLOCKED | No blockers plumbing references found |
| WI-1200 acceptance: existing tests pass | `WORK_QUEUE/WI-1200.md` | cards/games/results regressions green | ✗ BLOCKED | cards smoke test still failing |
| WI-1200 acceptance: strict typecheck clean | `WORK_QUEUE/WI-1200.md` | web type health | ✓ SATISFIED | `npm --prefix web run typecheck` passed |

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
| --- | --- | --- | --- | --- |
| `web/src/app/api/cards/route.ts` | 191 | Local legacy status normalization helper in route surface | ⚠️ Warning | Reintroduces local interpretation in scoped canonicalization path |
| `web/src/app/api/cards/route.ts` | 208 | Route-local projection official status resolver | ⚠️ Warning | Duplicates decision interpretation responsibility |
| `web/src/lib/runtime-decision-authority.ts` | 78 | Local canonical-status-to-display mapping layer | ⚠️ Warning | Competes with WI-1199 DecisionOutcome contract as source of truth |

### Human Verification Required

No human-only checks were required for this re-verification. Blocking findings remain code-level and programmatically observable.

### Gaps Summary

No previously reported WI-1200 gaps were closed in this re-verification pass. Canonical builder wiring, parity tests, blocker surfacing, and cards regression closure remain outstanding.

---

_Verified: 2026-04-28T01:29:55Z_
_Verifier: Claude (gsd-verifier)_
