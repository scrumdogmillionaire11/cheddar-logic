---
phase: quick-49
plan: 49
subsystem: planning-docs
tags: [mlb, pitcher-props, research-spec, implementation-contract]
dependency_graph:
  requires: []
  provides: [MLB-pitcher-ks-implementation-contract]
  affects: [WI-0390, WI-0391, WI-0392]
tech_stack:
  added: []
  patterns: [cards-first-no-settlement, gated-abstain-pattern, deterministic-test-vectors]
key_files:
  created: []
  modified:
    - .planning/MLB-research.md
    - WORK_QUEUE/COMPLETE/WI-0389.md
decisions:
  - "v1 scope is cards-only with no settlement, no CLV ledger writes, no settle_pending_cards integration"
  - "MIN_EDGE fixed at 0.04 (4 percentage points), not configurable at runtime"
  - "sigma fixed at 1.8 for v1 normal distribution (empirical MLB K distribution std)"
  - "price cap at -160 for both over and under sides"
  - "pitcher_leash gate set at avg_pitch_count >= 75 over last 5 starts"
  - "stale_data gate: odds must be captured within 4 hours of game start"
  - "BvP, catcher framing, and bullpen fatigue explicitly deferred from v1"
metrics:
  duration: ~10 minutes
  completed: 2026-03-17T00:46:21Z
  tasks_completed: 2
  tasks_total: 2
  files_modified: 2
---

# Phase quick-49 Plan 49: MLB Pitcher Ks Research Spec Freeze Summary

**One-liner:** Rewrote MLB-research.md from a research narrative into a frozen 7-section implementation contract with explicit consensus-line math, 8 gating thresholds, full payload JSON schema, 9 failure mode codes, and 7 deterministic test vectors.

---

## What Was Built

`.planning/MLB-research.md` was a research narrative (~580 lines of research notes, data source catalogs, and conceptual recommendations). It contained no structured spec sections, no deterministic thresholds, no payload schema, and no test vectors. WI-0389 acceptance criteria required it to be a frozen implementation contract.

The file was completely replaced with a structured 7-section spec:

- **Objective**: v1 scope explicitly cards-only, no settlement, no CLV ledger, no settle_pending_cards
- **Data Sources**: 6 canonical sources with exact endpoint paths and field names
- **Model Math**: consensus line derivation, American odds to implied probability, projected Ks formula, edge calculation, PLAY/PASS/ABSTAIN decision logic
- **Gates**: 8 gates in table form with thresholds and exact failure reason codes
- **Payload Contract**: complete `payload_data` JSON schema for `card_type=mlb-pitcher-ks`
- **Failure Modes**: 9 failure scenarios with card-written flag and reason codes
- **Test Vectors**: 7 vectors (3 PLAY, 1 PASS, 3 ABSTAIN) with full derived math and expected output fields

WI-0389 was then moved to `WORK_QUEUE/COMPLETE/` with a completion block.

---

## Tasks Completed

| Task | Name | Commit | Files |
|------|------|--------|-------|
| 1 | Rewrite .planning/MLB-research.md as frozen implementation contract | a298ced | .planning/MLB-research.md |
| 2 | Mark WI-0389 complete and move to COMPLETE/ | fea5aed | WORK_QUEUE/COMPLETE/WI-0389.md |

---

## Decisions Made

1. **v1 = cards-only, no settlement** — explicit in Objective section; no settlement fields in payload schema
2. **MIN_EDGE = 0.04** — fixed constant, not runtime-configurable for v1
3. **sigma = 1.8** — fixed for v1 normal distribution model; empirical MLB K distribution std
4. **Price cap = -160** — both over and under sides; worse prices result in ABSTAIN
5. **Pitcher leash gate = avg_pitch_count >= 75** — over last 5 starts
6. **Stale odds gate = 4 hours** — captured_at must be within 4 hours of game start
7. **BvP/catcher framing/bullpen fatigue deferred** — explicitly out of v1 scope

---

## Verification Results

```
test -s .planning/MLB-research.md                          PASS
rg finds all 7 required section headings                   PASS
rg -n "TBD|TODO" .planning/MLB-research.md (no matches)   PASS
WI-0389.md in WORK_QUEUE/COMPLETE/                         PASS
WI-0389.md absent from WORK_QUEUE/                         PASS
```

---

## Deviations from Plan

None — plan executed exactly as written. The only minor fix was removing a "Do not add TBD/TODO" note from the file header that was triggering a false positive on the `rg "TBD|TODO"` acceptance test.

---

## Self-Check

- `.planning/MLB-research.md` exists and is non-empty: PASS
- `WORK_QUEUE/COMPLETE/WI-0389.md` exists: PASS
- `WORK_QUEUE/WI-0389.md` absent: PASS
- Commit a298ced exists: PASS
- Commit fea5aed exists: PASS

## Self-Check: PASSED
