# WORK_QUEUE

`WORK_QUEUE/` is the single source of truth for active and upcoming work.

## Active Work Items (Prioritized)

**Updated**: 2026-03-10

### P0: Production Blockers

- ~~WI-0367: Deploy branch fixes to Pi~~ ✅ **COMPLETE** (2026-03-09)

### P1: Settlement & Results Integrity

- ~~WI-0368: Frontend Play Settlement Coverage Parity~~ ✅ **COMPLETE** (2026-03-10)
- **WI-0370: NHL Settlement Enrollment + Sport Casing Fix** 🆕
  - Fix `card_results` sport casing write-path so NHL PLAY/LEAN rows enroll reliably
  - Add regression coverage for NHL settlement eligibility when finals are available

### P2: Decision Pipeline Hardening

- ~~WI-0345: Web API + Transform v2 Pass-Through Hard Cut~~ ✅ **COMPLETE** (2026-03-10)
- **WI-0373: Canonical Settlement P/L Calculation (Forward-Only)** 🆕
  - Canonical forward-only P/L rules for wins/losses/pushes and malformed odds
  - Keep W/L grading resilient while treating P/L as optional metadata when unavailable

### P3: Diagnostics & Observability

- **WI-0349: Per-Game Pipeline State Contract**
  - Canonical pipeline state with stage checkpoints
  - Explicit blocking reason codes for missing-data diagnosis

### P4: Code Quality & Maintenance

- ~~WI-0369: Settlement Telemetry Cleanup (W/L-First)~~ ✅ **COMPLETE** (2026-03-10)
- **WI-0371: Backfill Historical card_results Sport Casing + Guardrail** 🆕
  - Normalize legacy mixed-case `card_results.sport` values to lowercase
  - Add explicit backfill + regression guardrail follow-through after WI-0370
- **WI-0366: Extract normalizeRawDataPayload to shared utils**
  - Remove three identical copies from model runners
  - Single shared import

### P5: Feature Enhancements

- **WI-0354: Rank-Aware Strategy Kernel (FPL)** 🔄 (In Progress - Codex)
  - Auto strategy mode for FPL solver
  - Transfer/captain/chip behavior based on rank bucket

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
