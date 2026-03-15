---
phase: 42-update-wi-0437-plan-header-to-match-bott
plan: "01"
subsystem: work-queue-docs
tags: [soccer, wi-spec, tier1, documentation]
key-files:
  modified:
    - WORK_QUEUE/WI-0437.md
decisions:
  - "WI-0437 top section is now the single source of truth: Goal names Tier 1 hardening explicitly, not just generic hardening"
  - "Verbose design-notes appendix (## Summary through ## Recommendation, ~438 lines) removed; replaced by 8-stage condensed Implementation Plan"
  - "Acceptance criteria rewritten from 4 vague bullets to 7 numbered invariants matching the five new payload invariants plus output-compat and defer-rationale requirements"
metrics:
  duration: "< 5 minutes"
  completed: "2026-03-14"
  tasks_completed: 1
  files_modified: 1
---

# Quick Task 42: Update WI-0437 Plan Header to Match Bottom Design Notes — Summary

**One-liner**: Rewrote WI-0437 top section to make Tier 1 soccer hardening (Player Shots, Team Totals, TSOA) the explicit, unambiguous spec — removing 438 lines of verbose design-notes appendix and replacing with a lean 8-stage Implementation Plan.

## What Changed in WI-0437.md

### Top section (lines 1–~65)

| Section | Before | After |
|---|---|---|
| Title | "Soccer Data Hardening (Environment Projector Incremental, No Rebuild)" | "Soccer Data Hardening — Tier 1 Market Payloads (Player Shots, Team Totals, TSOA)" |
| Goal | Generic: "reduce mock/placeholder behavior while preserving current runtime flow" | Specific: names Tier 1 markets explicitly, states no-projector-rebuild constraint |
| Scope | 5 file entries only | 5 files + 7 supporting contract files listed as read-only references |
| Out of scope | 4 bullets, no specific market names | 6 bullets: explicitly bans draw odds, DNB/AH, match totals, BTTS, cards/fouls; clarifies Tier 2 is conditional bonus only |
| Acceptance | 4 vague bullets about "reducing placeholder usage" | 7 numbered invariants: market family declaration, hardened projection context, player eligibility, structured flags over placeholders, validator-as-bouncer, output compat, deferred gap documentation |
| Manual validation | One generic sentence | 5-item checklist with specific surface URLs and behavior |

### Bottom section

- Removed: `## Summary`, `## Why This Is Needed`, `## Design`, `## Tests Required`, `## Failure Modes & Guards`, `## Open Questions`, `## Recommendation` (~438 lines of verbose design notes)
- Added: condensed `## Implementation Plan` with 8 stages (A–H) plus Open question, drawn directly from the design notes

## Key Decisions Reflected

**Tier 1 only as primary success path.** Player Shots, Team Totals, and TSOA are the explicit success markets. Tier 2 (SOT, Anytime, Corners) is conditional bonus output only — not success criteria.

**Draw odds / legacy markets explicitly deferred.** Out of scope names draw odds, DNB, AH, match totals, BTTS, cards, fouls by name. Deferred section explains why each gap is deferred and what follow-up WI handles it.

**Validator as bouncer.** Acceptance criterion #5 explicitly frames `card-payload.js` as a hard allowlist enforcer, not a greeter — a pattern already in the design notes, now elevated to the acceptance bar.

**Structured flags over placeholders.** Acceptance criterion #4 codifies the core invariant: missing context becomes flags, not silent `"unknown"`/`"tbd"`/`0` backfills.

**Single source of truth.** The verbose design appendix existed because the original top section was too generic for an executor to act on. Now the top section alone is sufficient — any executor can implement from it without needing supplementary context.

## Files Modified

- `WORK_QUEUE/WI-0437.md` — full rewrite: top section + bottom section

## Deviations from Plan

None — plan executed exactly as written.

## Self-Check

- [x] `WORK_QUEUE/WI-0437.md` exists and contains Tier 1 in Goal and Acceptance
- [x] `## Summary` section absent
- [x] `## Recommendation` section absent
- [x] `## Implementation Plan` section present with 8-stage breakdown
- [x] `draw odds` appears only in Out of scope and Deferred sections
- [x] `player_shots`, `team_totals`, `to_score_or_assist` appear in Acceptance and Implementation Plan

## Self-Check: PASSED
