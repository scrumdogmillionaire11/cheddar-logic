# Results + Settlement Hardening Phased Roadmap

Date: 2026-04-28
Status: Draft for refinement

## Goal
Address three high-priority concerns with low-risk sequencing:
- Enforce `/api/results` performance budgets for high-cardinality datasets.
- Add explicit surfaced-play settlement policy regression coverage.
- Remove or wire legacy dead paths in results transform logic.

## Phase Sequence
1. Phase 0 - Baseline and guardrails
2. Phase 1 - `/api/results` performance budget harness (WI-1210)
3. Phase 2 - surfaced-play settlement policy regression matrix (WI-1211)
4. Phase 3 - transform-layer legacy helper cleanup (WI-1212)
5. Phase 4 - closeout and concern-status update

## Parallelization Rules
- Phase 1 and Phase 2 can run in parallel if owners are different.
- Phase 3 must run after Phase 1 because both touch results transform/query surface.

## Definition of Done
- Performance tests fail on latency/heap regressions.
- Settlement tests fail on unsurfaced non-exception settlement and duplicate settlement paths.
- Legacy helpers are either removed or proven runtime-relevant with behavioral tests.
- `.planning/codebase/CONCERNS.md` is updated with resolved/reduced status.

## Risk Controls
- Prefer seeded behavioral tests over source-string assertions.
- Keep WI-level file scope strict.
- Add explicit threshold rationale in test comments to avoid magic numbers.

## Exit Checklist
- Commands run and captured for all three streams.
- No unrelated diff spillover outside WI scope.
- Residual risks documented if any concern remains open.
