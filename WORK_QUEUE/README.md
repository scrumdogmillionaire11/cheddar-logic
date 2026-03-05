# WORK_QUEUE

`WORK_QUEUE/` is the single source of truth for active and upcoming work.

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
