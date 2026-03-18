# WORK_QUEUE

`WORK_QUEUE/` is the single source of truth for active and upcoming work.

## Active Work Items

**Updated**: 2026-03-17

- None currently active (`WORK_QUEUE/` contains no `WI-####.md` files).
- Start new work by creating a new item from `WORK_QUEUE/WI-TEMPLATE.md`.

## Recently Completed

- `WI-0480`: Phase 2 Activation + Rollback Procedure (Thresholds V2)
- `WI-0481`: Phase 3 Preflight Eligibility + SQL Verification (CLV)
- `WI-0482`: Phase 3 Activation + Settlement-Safe Rollback (CLV)
- `WI-0483`: Fix nba-blowout-risk role and document unclassified NHL cardTypes in DRIVER_ROLES
- `WI-0484`: DRIVER_ROLES registry completeness guard

## Rules

- One file per work item: `WI-####.md`
- Work is exclusive while claimed
- Agents only edit files listed in `Scope`
- Scope expansion must be written into the work item before code changes

## Lifecycle

1. `Unclaimed` (owner unset or `unassigned`)
2. `Claimed` (`Owner agent` set + `CLAIM:` line with timestamp)
3. `In progress` (edits happening only inside scope)
4. `Ready for review` (acceptance and testing evidence added)
5. `Closed` (merged or explicitly cancelled)

## Naming

- Branch: `agent/<agent-name>/WI-####-short-slug`
- Commit: `WI-####: <imperative summary>`

## Required Work Item Fields

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

Use `WORK_QUEUE/WI-TEMPLATE.md` for new items.
