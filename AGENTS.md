# AGENTS.md

## Purpose
Multiple agents contribute safely by enforcing exclusive scopes, work-item claims, and serialized shared touchpoints.

## Current State Snapshot (Authoritative)
- Source: `.planning/STATE.md` (last activity: 2026-03-04)
- Current phase: `2 of 4` complete
- Status: `Ready for Phase 3 (Documentation & Handoff)`
- Phase 3 objective: formalize ownership contracts, runbooks, and enforcement guardrails

## Source-Of-Truth Order
When files conflict, apply this precedence in order:
1. Active `WORK_QUEUE/WI-####.md` scope
2. `.planning/STATE.md`
3. `OWNERSHIP.md`
4. `docs/decisions/ADR-####.md`
5. Any other planning/doc file

## Canonical Agent + Workflow Sources
- PAX agent definitions: `pax-agents/.claude/agents/pax-*.md`
- PAX command/workflow specs: `pax-agents/.claude/commands/pax/` and `pax-agents/.claude/process-acceleration-executors/`
- Local command mirror (runtime use): `.claude/commands/` and `.claude/process-acceleration-executors/`
- Copilot mapping layer: `.github/copilot-instructions.md`

## Workflow
1. Pick a work item in `WORK_QUEUE/`.
2. Claim it by setting `Owner agent:` and adding `CLAIM: <agent> <ISO8601>`.
3. Only edit files listed under `Scope`.
4. Keep diffs minimal and scoped.
5. Open one PR per work item.

## Work Item Rules
- Agents may not edit files outside the work item `Scope`.
- Any scope expansion must be written into the work item before code changes.
- If two items need the same file, split by file boundary or rescope into one item with a single owner.
- Required fields in each work item:
  - `ID`
  - `Goal`
  - `Scope`
  - `Out of scope`
  - `Acceptance`
  - `Owner agent`
  - `Time window`
  - `Coordination flag`
  - `Tests to run`
  - `Manual validation`

## Non-Negotiables
- One agent owns one change-set.
- No shared ownership of the same files in the same window.
- Every change is traceable to a single work item ID.
- No repo-wide formatting, cleanup, or renames outside scope.
- If a change is not in scope, it does not happen.
- Production DB path must be set via CHEDDAR_DB_PATH to the canonical DB file that contains card_payloads; avoid legacy DB path vars and keep docs/workflows aligned.

## Branch/Commit Protocol
- Branch: `agent/<agent-name>/WI-####-short-slug`
- Commit: `WI-####: <imperative summary>`
- One work item maps to one PR.

## Scope Hygiene
Agents must not:
- Run formatters on the whole repo
- Reorder imports outside touched modules
- Rename symbols outside scope
- Change lint/format/tooling without ADR plus `needs-sync`
- Do drive-by fixes without creating a new work item

Agents may:
- Apply minimal formatting required by existing lint rules
- Perform strictly necessary refactors inside scoped files to pass tests

## Serialized Shared Touchpoints (`needs-sync` required)
- Lockfiles: `package-lock.json`, `web/package-lock.json`
- CI/workflow config: `.github/workflows/**`
- Lint/format config: `eslint.config.mjs`, `.prettierrc`, `.eslintignore`, `.prettierignore`
- DB migrations: `packages/data/db/migrations/**`
- Public API surfaces:
  - `web/src/app/api/**`
  - `apps/worker/src/jobs/*.js` where endpoint/output contracts change
  - `packages/data/src/market-contract.js`
  - `apps/worker/src/models/fpl-types.js`
- Global shared schemas/types:
  - `packages/data/src/validators/**`
  - `web/src/lib/types/**`
  - `web/src/types/**`

## Integration Cadence
- Rebase or merge latest `main` at work-item start.
- Rebase or merge latest `main` immediately before PR.
- If a diff grows beyond ~300-500 LOC net, split into new work items.

## Conflict Resolution
1. Active work item scope owner wins.
2. `OWNERSHIP.md` primary owner wins if scopes overlap.
3. If unresolved: create ADR, assign a single decider, all others pause edits on affected files.

## Testing + PR Evidence
Each work item must define:
- Exact tests to run (unit/integration/smoke)
- Manual validation steps if no automated tests apply

Each PR must include:
- Tests run and results
- Confirmation that changed files match scope
- Confirmation of no unrelated diffs

## Decision Logging
If a change affects architecture, public API, or cross-agent conventions:
- Add `docs/decisions/ADR-####.md`
- Link that ADR from the work item

## Maintenance Rules
For updates to PAX artifact packages in this repo:
1. Edit canonical files in `pax-agents/.claude/agents/` first.
2. Keep command/workflow references valid (`@./.claude/...` style paths).
3. Run:
   - `./pax-agents/tests/link-integrity.sh .`
   - `./pax-agents/scripts/doctor.sh .`
4. Update `pax-agents/CHANGELOG.md` and `pax-agents/.claude/process-acceleration-executors/VERSION` for releases.
