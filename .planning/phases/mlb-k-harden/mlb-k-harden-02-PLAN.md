---
phase: mlb-k-harden
plan: "02"
type: execute
wave: 1
depends_on: []
files_modified:
  - docs/mlb_projection_input_contract.md
  - WORK_QUEUE/COMPLETE/WI-0742.md
autonomous: true

must_haves:
  truths:
    - "docs/mlb_projection_input_contract.md exists with a three-column table: field | tier | notes"
    - "FULL_MODEL required fields are enumerated"
    - "FALLBACK trigger fields are enumerated"
    - "WI-0742 FALLBACK semantics footnote added without touching acceptance criteria"
  artifacts:
    - path: "docs/mlb_projection_input_contract.md"
      provides: "Official MLB K input contract: core vs secondary vs FALLBACK table"
      min_lines: 60
    - path: "WORK_QUEUE/COMPLETE/WI-0742.md"
      provides: "FALLBACK semantics footnote clarifying whiff/leash/contact proxy = FALLBACK"
  key_links: []
---

<objective>
Write the official MLB K projection input contract doc and tighten WI-0742 with
an explicit FALLBACK semantics footnote. These are reference documents that
downstream implementers (and auditors) will use to validate code correctness.

Purpose: One canonical place that says "this field forces FALLBACK, this field forces DEGRADED_MODEL."
Output: docs/mlb_projection_input_contract.md + WI-0742 footnote.
</objective>

<execution_context>
@./.claude/process-acceleration-executors/workflows/execute-plan.md
@./.claude/process-acceleration-executors/templates/summary.md
</execution_context>

<context>
@.planning/STATE.md
@WORK_QUEUE/WI-0747.md
@WORK_QUEUE/COMPLETE/WI-0742.md
</context>

<tasks>

<task type="auto">
  <name>Task 1: Create docs/mlb_projection_input_contract.md with field tier table</name>
  <files>docs/mlb_projection_input_contract.md</files>
  <action>
Create the doc with these sections:

## Overview
One paragraph: this doc is the source of truth for which MLB pitcher-K inputs
are required for FULL_MODEL, which allow DEGRADED_MODEL, and which force FALLBACK.
Implemented in: apps/worker/src/jobs/mlb-k-input-classifier.js

## Input Stages
Brief description of the four input objects: StarterSkillInput, OpponentContactInput, LeashInput, ProjectionQualityDecision.

## Field Tier Table
Three-column markdown table: `| Field | Tier | Notes |`

Tier = FULL_MODEL_REQUIRED, DEGRADED_OK, FALLBACK_TRIGGER.

Rows:
| k_pct (starter)           | FULL_MODEL_REQUIRED  | Core K rate; no substitute |
| swstr_pct OR csw_pct      | FULL_MODEL_REQUIRED  | At least one must be real; proxy → FALLBACK |
| pitch_count_avg OR ip_avg | FULL_MODEL_REQUIRED  | Leash gate; proxy → FALLBACK |
| k_pct_vs_hand (opponent)  | FULL_MODEL_REQUIRED  | Must be vs same handedness |
| contact_pct_vs_hand       | FULL_MODEL_REQUIRED  | Missing → FALLBACK |
| chase_pct_vs_hand         | DEGRADED_OK          | Missing → DEGRADED_MODEL |
| projected_lineup_status   | DEGRADED_OK          | PROJECTED (not CONFIRMED) → DEGRADED_MODEL |
| park/weather overlay      | DEGRADED_OK          | Absent → DEGRADED_MODEL |
| whiff_proxy               | FALLBACK_TRIGGER     | Signals real swstr_pct/csw_pct unavailable |
| ip_proxy                  | FALLBACK_TRIGGER     | Signals real leash metric unavailable |

## Quality Decision Rules
Prose + short pseudocode block matching classifyMlbPitcherKQuality decision logic.

## FALLBACK Behavior
When model_quality === FALLBACK:
- Numeric projection still emitted
- play_range boundaries tightened (per WI-0742 cap rules)
- "Cap PASS" shown; do not publish STRONG play_range claims
- All proxy/hardMissing fields listed in degradation_reasons

## Open Questions (from WI-0747)
List the three open questions from WI-0747 verbatim, with status "unanswered — see upstream audit".
  </action>
  <verify>wc -l docs/mlb_projection_input_contract.md && grep -c 'FALLBACK_TRIGGER\|FULL_MODEL_REQUIRED\|DEGRADED_OK' docs/mlb_projection_input_contract.md</verify>
  <done>File exists, >= 60 lines, grep returns >= 10 matching lines</done>
</task>

<task type="auto">
  <name>Task 2: Add FALLBACK semantics footnote to WORK_QUEUE/COMPLETE/WI-0742.md</name>
  <files>WORK_QUEUE/COMPLETE/WI-0742.md</files>
  <action>
Append a section at the end of WI-0742.md:

---

## FALLBACK Semantics — Addendum (WI-0747)

The original WI-0742 `model_quality` tiers were correct in spirit but did not
explicitly enumerate which missing inputs force FALLBACK vs DEGRADED_MODEL.
This addendum locks those semantics:

**MLB_PITCHER_K FALLBACK triggers (any one → model_quality = FALLBACK):**
- `starter_whiff_proxy` used in place of real swstr_pct / csw_pct
- `ip_proxy` used in place of real pitch_count_avg / ip_avg
- `contact_pct_vs_hand` absent (opponent contact profile unavailable for handedness)
- `k_pct_vs_hand` absent
- `k_pct` (starter) absent

**DEGRADED_MODEL (none of the above; secondary gap only):**
- chase_pct_vs_hand absent
- lineup status PROJECTED (not CONFIRMED)
- park/weather overlay absent

**FULL_MODEL:** All FULL_MODEL_REQUIRED fields present with real (non-proxy) values.

Reference implementation: `apps/worker/src/jobs/mlb-k-input-classifier.js`
Contract doc: `docs/mlb_projection_input_contract.md`

Do not alter any other section of WI-0742.md. Append only.
  </action>
  <verify>grep -c 'FALLBACK Semantics' WORK_QUEUE/COMPLETE/WI-0742.md</verify>
  <done>grep returns 1 (section added exactly once)</done>
</task>

</tasks>

<verification>
wc -l docs/mlb_projection_input_contract.md
grep 'FALLBACK_TRIGGER' docs/mlb_projection_input_contract.md | wc -l
grep 'FALLBACK Semantics' WORK_QUEUE/COMPLETE/WI-0742.md
</verification>

<success_criteria>
- docs/mlb_projection_input_contract.md exists, >= 60 lines, contains tier table
- WI-0742.md has FALLBACK Semantics footnote appended, nothing else touched
</success_criteria>

<output>
After completion, create `.planning/phases/mlb-k-harden/mlb-k-harden-02-SUMMARY.md`
</output>
