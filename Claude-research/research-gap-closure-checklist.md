# Research Gap Closure Checklist

## Purpose

This checklist maps the research goals in [research-prompt.md](research-prompt.md) to the current repo implementation and identifies work that is still open.

## Current System Snapshot

- Production runtime is Node/JS worker + web pipeline (not a Python sidecar betting service):
  - [README.md](../README.md)
  - [apps/worker/package.json](../apps/worker/package.json)
  - [apps/worker/src/schedulers/main.js](../apps/worker/src/schedulers/main.js)
- Research prototypes exist under `Claude-research/files`, but are not wired into production jobs:
  - [Claude-research/files/edge_engine.py](files/edge_engine.py)
  - [Claude-research/files/play_schema.py](files/play_schema.py)
  - [Claude-research/files/projection_engine.py](files/projection_engine.py)

## Requirement-to-Implementation Matrix

| Research Requirement | Current State | Evidence | Status | Closure Path |
|---|---|---|---|---|
| Calibration over raw hit-rate | Telemetry reporting + separation contracts are implemented for existing worker flows | [apps/worker/src/jobs/report_telemetry_calibration.js](../apps/worker/src/jobs/report_telemetry_calibration.js), [docs/ARCHITECTURE_SEPARATION.md](../docs/ARCHITECTURE_SEPARATION.md) | Implemented (baseline) | Keep as operating guardrail |
| CLV as core metric | CLV framework exists and is flag-gated in worker settlement pipeline | [apps/worker/src/jobs/settle_pending_cards.js](../apps/worker/src/jobs/settle_pending_cards.js), [docs/ARCHITECTURE_SEPARATION.md](../docs/ARCHITECTURE_SEPARATION.md) | Implemented (baseline) | Extend to open sport-specific WIs |
| Soccer web parity for GAME_TOTAL/DOUBLE_CHANCE | Soccer market alias handling present in web API and tests | [web/src/app/api/games/route.ts](../web/src/app/api/games/route.ts), [web/src/__tests__/api-games-soccer-market-contract.test.js](../web/src/__tests__/api-games-soccer-market-contract.test.js) | Implemented | None |
| Full Python sidecar architecture (odds_api_client, market_router, python_client bridge) | Research-only artifacts; no production wiring | [Claude-research/research-prompt.md](research-prompt.md), [Claude-research/files/ARCHITECTURE.md](files/ARCHITECTURE.md) | Not implemented in live runtime | Decide whether to adopt sidecar or retire this path |
| Fractional Kelly staking in production edge flow | Exists in research prototype only, not in current worker model jobs | [Claude-research/files/kelly.py](files/kelly.py), [Claude-research/files/edge_engine.py](files/edge_engine.py) | Not implemented (production) | Optional future WI (if staking output is desired) |
| Soccer xG foundation (FBref ingest + Poisson + cache table) | Planned in queue, not present as scoped files in this branch | [WORK_QUEUE/WI-0491.md](../WORK_QUEUE/WI-0491.md), [docs/SOCCER_MODEL_SPECIFICATION.md](../docs/SOCCER_MODEL_SPECIFICATION.md) | Open | Execute WI-0491 |
| Soccer edge repair (model_prob - implied_prob) + soccer CLV settlement job | Planned in queue, not present as scoped files in this branch | [WORK_QUEUE/WI-0492.md](../WORK_QUEUE/WI-0492.md), [docs/SOCCER_MODEL_SPECIFICATION.md](../docs/SOCCER_MODEL_SPECIFICATION.md) | Open | Execute WI-0492 |
| MLB expansion tranche A/B with decision-basis + telemetry separation | Both active and explicitly sequential | [WORK_QUEUE/WI-0487.md](../WORK_QUEUE/WI-0487.md), [WORK_QUEUE/WI-0488.md](../WORK_QUEUE/WI-0488.md) | Open | Execute WI-0487 then WI-0488 |
| NFL expansion after MLB | Explicitly deferred and dependency-blocked by MLB B | [WORK_QUEUE/WI-0489.md](../WORK_QUEUE/WI-0489.md) | Open (deferred) | Keep last |

## Active Work Left (Execution Order)

1. [WORK_QUEUE/WI-0491.md](../WORK_QUEUE/WI-0491.md) — soccer xG foundation
2. [WORK_QUEUE/WI-0492.md](../WORK_QUEUE/WI-0492.md) — soccer edge repair + soccer CLV settlement
3. [WORK_QUEUE/WI-0487.md](../WORK_QUEUE/WI-0487.md) — MLB tranche A
4. [WORK_QUEUE/WI-0488.md](../WORK_QUEUE/WI-0488.md) — MLB tranche B
5. [WORK_QUEUE/WI-0489.md](../WORK_QUEUE/WI-0489.md) — NFL expansion (**last**)

## Architecture Decision (DECIDED)

__Path B: Keep as reference-only research__ — Research prototype assets under `Claude-research/files/` are retained as documentation and algorithmic reference, but NOT promoted to production.

- ✅ __Decided:__ ADR-0005 documents the full rationale
- ✅ __Status:__ Python sidecar remains non-adopted; no production wiring
- ✅ __Impact:__ Active sport expansion (Soccer, MLB, NFL) proceeds in Node/JS; no architectural change required

See [docs/decisions/ADR-0005-python-research-reference-only.md](../../docs/decisions/ADR-0005-python-research-reference-only.md) for reasoning, future reversibility, and ownership for potential changes.

## Definition of “Research Complete” for this repo

Mark research complete only when all are true:

- Open execution WIs above are moved from `WORK_QUEUE/` to `WORK_QUEUE/COMPLETE/`
- Soccer model phases in [docs/SOCCER_MODEL_SPECIFICATION.md](../docs/SOCCER_MODEL_SPECIFICATION.md) are reflected by real code artifacts (or intentionally descoped)
- Python sidecar decision is explicit (adopted with implementation WIs, or rejected and archived as reference)
- NFL remains last unless the dependency chain is formally changed
