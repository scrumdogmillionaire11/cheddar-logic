# ADR-0011: FPL Integration Architecture — Keep Standalone (Option C)

- Status: Accepted
- Date: 2026-04-05
- Supersedes: N/A
- Work item: WI-0767

## Context

`cheddar-fpl-sage/` is a self-contained Python/React application for Fantasy
Premier League (FPL) team management. It maintains its own YAML/JSON data store
and its own process lifecycle — it has no shared DB, no shared Node runtime, and
no npm packages in common with the main cheddar-logic worker.

The main Node worker (`apps/worker/`) contains a dedicated FPL scheduler
(`apps/worker/src/schedulers/fpl.js`) that computes due jobs for FPL model
runs keyed on GW deadlines. That scheduler exists, but the corresponding job
(`run_fpl_model.js`) does not pull or write FPL data from the main worker DB —
it is a bridge stub that was never fully wired.

A prior copy-paste error also meant the FPL scheduler's env-var guard
(`ENABLE_FPL_MODEL`) was accidentally wired to `ENABLE_NFL_MODEL` in the old
`SPORT_JOBS` registry in `main.js`. That was fixed as a side effect of the
WI-0780 scheduler refactor, which removed the `SPORT_JOBS` registry entirely;
`fpl.js` now reads `ENABLE_FPL_MODEL` directly.

## Options Considered

### Option A — Integrate into main worker

Build `pull_fpl_data.js` that reads FPL API (or queries cheddar-fpl-sage's
local store) and writes rows into the main cheddar-logic DB tables. Run
`run_fpl_model.js` as a normal job inside the tick loop.

- Pro: FPL picks displayed alongside NHL/NBA/MLB cards in the web UI
- Con: Requires a non-trivial Python→Node data bridge or direct FPL API integration
- Con: FPL API has strict rate limits and GW-cadence release cycles incompatible
  with the 5-minute tick loop
- Con: No FPL data tables exist in the main DB schema; DB migration needed

### Option B — Keep standalone, add bridge

`cheddar-fpl-sage` keeps its Python runtime and DB. A lightweight export
(HTTP endpoint, file drop, or shared SQLite) feeds aggregated FPL context
into the main worker's DB so `run_fpl_model.js` can read it.

- Pro: Separates data collection from model logic
- Con: Adds a synchronization dependency between two independent processes
- Con: Bridge failure modes are complex and hard to test

### Option C — Keep fully standalone, no bridge ← *chosen*

FPL remains a completely separate application. The FPL scheduler stub
(`fpl.js`) is kept in the codebase because it is harmless, self-contained,
and already correctly gated by `ENABLE_FPL_MODEL=false`. No bridge is built.

- Pro: No additional complexity in the main worker
- Pro: `cheddar-fpl-sage` evolves independently at its own cadence
- Pro: Zero risk of FPL failure modes affecting NHL/NBA/MLB card generation
- Con: FPL picks are not surfaced in the main cheddar-logic web UI

## Decision

**Option C** — FPL remains standalone. The `fpl.js` scheduler and `run_fpl_model.js`
job remain in the codebase disabled by `ENABLE_FPL_MODEL=false`. No data
integration work is planned.

The FPL scheduler and job files are retained rather than deleted because:

1. They are gated safely behind `ENABLE_FPL_MODEL=false`
2. They provide a well-structured entry point if a future integration is ever decided
3. Deleting them would require reverting an existing work item commitment

## Consequences

- `ENABLE_FPL_MODEL` defaults to `false` in `env.example` and production
- No DB migrations for FPL tables will be created unless this ADR is superseded
- `cheddar-fpl-sage/` is not treated as a dependency of the main worker CI
- Any future integration requires a new ADR and a concrete `pull_fpl_data.js` job

## Revisit Condition

Re-evaluate if:

- A `pull_fpl_data.js` job that writes FPL context into the main DB is proposed
  with a clear data model and an acceptable API rate-limit strategy
- FPL picks need to appear in the main web UI alongside other sport cards
