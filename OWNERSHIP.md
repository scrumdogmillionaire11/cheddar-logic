# OWNERSHIP.md

## Ownership Model
This file defines default ownership lanes by path. Work item scope always has priority over this table for the active claim window.

If a path is not listed here, create/update `OWNERSHIP.md` before editing that path.

## Owner Lanes
- `lane/agent-governance`: agent coordination policy, queue, ADR process
- `lane/docs-planning`: project docs, planning state, runbooks
- `lane/release-infra`: CI/CD, deployment, repo-level tooling
- `lane/data-platform`: DB schema, migrations, data contracts
- `lane/ingest-adapters`: ingestion and normalization adapters
- `lane/model-core`: shared model logic and sport model modules
- `lane/worker-betting`: betting worker jobs and schedules
- `lane/worker-fpl`: worker-side FPL integration boundaries
- `lane/web-platform`: web UI routes, APIs, shared web libs
- `lane/fpl-sage`: Python FPL Sage service

## Path Ownership Matrix
| Path / Glob | Primary Owner | Backup Owner | Notes |
| --- | --- | --- | --- |
| `AGENTS.md` | `lane/agent-governance` | `lane/docs-planning` | Coordination contract |
| `OWNERSHIP.md` | `lane/agent-governance` | `lane/docs-planning` | Ownership map |
| `WORK_QUEUE/**` | `lane/agent-governance` | `lane/docs-planning` | Work-item source of truth |
| `CHANGES/**` | `lane/agent-governance` | `lane/docs-planning` | Optional scratch and patch logs |
| `docs/decisions/**` | `lane/agent-governance` | `lane/docs-planning` | ADRs |
| `.planning/**` | `lane/docs-planning` | `lane/agent-governance` | State and phase planning artifacts |
| `docs/**` | `lane/docs-planning` | `lane/web-platform` | Architecture, runbooks, operations docs |
| `.github/workflows/**` | `lane/release-infra` | `lane/agent-governance` | Serialized touchpoint (`needs-sync`) |
| `.github/agents/**` | `lane/release-infra` | `lane/agent-governance` | Copilot-facing agent definitions |
| `.claude/**` | `lane/release-infra` | `lane/agent-governance` | Local runtime command/workflow mirror |
| `pax-agents/.claude/**` | `lane/agent-governance` | `lane/release-infra` | Canonical PAX artifact source |
| `pax-agents/scripts/**` | `lane/agent-governance` | `lane/release-infra` | PAX maintenance scripts |
| `pax-agents/tests/**` | `lane/agent-governance` | `lane/release-infra` | PAX integrity tests |
| `package-lock.json` | `lane/release-infra` | `lane/data-platform` | Serialized touchpoint (`needs-sync`) |
| `web/package-lock.json` | `lane/release-infra` | `lane/web-platform` | Serialized touchpoint (`needs-sync`) |
| `eslint.config.mjs` | `lane/release-infra` | `lane/agent-governance` | Serialized touchpoint (`needs-sync`) |
| `.prettierrc` | `lane/release-infra` | `lane/agent-governance` | Serialized touchpoint (`needs-sync`) |
| `.eslintignore` | `lane/release-infra` | `lane/agent-governance` | Serialized touchpoint (`needs-sync`) |
| `.prettierignore` | `lane/release-infra` | `lane/agent-governance` | Serialized touchpoint (`needs-sync`) |
| `packages/data/db/migrations/**` | `lane/data-platform` | `lane/worker-betting` | Serialized touchpoint (`needs-sync`) |
| `packages/data/src/**` | `lane/data-platform` | `lane/worker-betting` | Data contracts and db access |
| `packages/adapters/**` | `lane/ingest-adapters` | `lane/worker-betting` | Provider integration layer |
| `packages/odds/**` | `lane/ingest-adapters` | `lane/worker-betting` | Odds provider fetch/normalization |
| `packages/models/**` | `lane/model-core` | `lane/worker-betting` | Shared model modules |
| `apps/worker/src/models/**` | `lane/model-core` | `lane/worker-betting` | Sport model implementations |
| `apps/worker/src/jobs/run_*.js` | `lane/worker-betting` | `lane/model-core` | Main sport job entrypoints |
| `apps/worker/src/jobs/pull_*.js` | `lane/worker-betting` | `lane/ingest-adapters` | Ingestion jobs |
| `apps/worker/src/jobs/settle_*.js` | `lane/worker-betting` | `lane/data-platform` | Results/settlement pipeline |
| `apps/worker/src/schedulers/**` | `lane/worker-betting` | `lane/release-infra` | Scheduler behavior |
| `apps/worker/src/models/fpl-types.js` | `lane/worker-fpl` | `lane/fpl-sage` | Serialized touchpoint (`needs-sync`) |
| `apps/worker/src/jobs/run_fpl_model.js` | `lane/worker-fpl` | `lane/fpl-sage` | Worker FPL boundary |
| `cheddar-fpl-sage/**` | `lane/fpl-sage` | `lane/worker-fpl` | Python service source of truth |
| `web/src/app/api/**` | `lane/web-platform` | `lane/data-platform` | Public API touchpoint (`needs-sync` for contract changes) |
| `web/src/app/**` | `lane/web-platform` | `lane/docs-planning` | Next.js routes and pages |
| `web/src/components/**` | `lane/web-platform` | `lane/docs-planning` | UI components |
| `web/src/lib/**` | `lane/web-platform` | `lane/data-platform` | Shared web utilities/contracts |
| `web/src/types/**` | `lane/web-platform` | `lane/data-platform` | Global web types (`needs-sync` if cross-domain) |
| `scripts/**` | `lane/release-infra` | `lane/worker-betting` | Operational scripts |

## DB Domain Modules

All modules in `packages/data/src/db/` are owned by `lane/data-platform`.
The **only public entry point** is `packages/data/src/db/index.js`.
Direct imports of non-public modules from outside `packages/data/` are prohibited and enforced by CI (`check-db-import-boundaries`).

| Module | Owner | Permitted Consumers |
| --- | --- | --- |
| `index.js` | `lane/data-platform` | Any file in the repo (public entry point) |
| `auth-store.js` | `lane/data-platform` | `packages/data/` only |
| `cards.js` | `lane/data-platform` | `packages/data/` only |
| `connection.js` | `lane/data-platform` | `packages/data/` only |
| `games.js` | `lane/data-platform` | `packages/data/` only |
| `job-runs.js` | `lane/data-platform` | `packages/data/` only |
| `models.js` | `lane/data-platform` | `packages/data/` only |
| `odds.js` | `lane/data-platform` | `packages/data/` only |
| `players.js` | `lane/data-platform` | `packages/data/` only |
| `quota.js` | `lane/data-platform` | `packages/data/` only |
| `results.js` | `lane/data-platform` | `packages/data/` only |
| `scheduler.js` | `lane/data-platform` | `packages/data/` only |
| `tracking.js` | `lane/data-platform` | `packages/data/` only |

## Escalation Rule For Ownership Conflicts
If a file is touched by two work items:
1. Stop edits on that file.
2. Split work by file boundary or create a new unified work item with one owner.
3. If still ambiguous, resolve via ADR in `docs/decisions/`.
