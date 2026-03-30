---
phase: quick
plan: 114
subsystem: fpl-ui
tags: [fpl, ui, components, onboarding, draft-lab, screenshot-audit, compare]
dependency_graph:
  requires: [WI-0653, WI-0654, WI-0655, WI-0656, WI-0659]
  provides: [fpl-onboarding, fpl-draft-lab, fpl-draft-candidate-card, fpl-screenshot-uploader, fpl-parse-review, fpl-draft-audit, fpl-draft-compare]
  affects: [fpl-product-shell]
tech_stack:
  added: []
  patterns: [react-client-components, tailwind-surface-tokens, source-text-contract-tests]
key_files:
  created:
    - web/src/components/fpl-onboarding.tsx
    - web/src/components/fpl-draft-lab.tsx
    - web/src/components/fpl-draft-candidate-card.tsx
    - web/src/components/fpl-screenshot-uploader.tsx
    - web/src/components/fpl-parse-review.tsx
    - web/src/components/fpl-draft-audit.tsx
    - web/src/components/fpl-draft-compare.tsx
    - web/src/__tests__/fpl-draft-coach-contract.test.js
    - web/src/__tests__/fpl-screenshot-audit-contract.test.js
  modified:
    - web/src/components/fpl-product-shell.tsx
decisions:
  - Hardcoded userId="demo" in shell wiring (no auth system yet; plan-specified)
  - Screenshot section maintains local state machine (upload->review->audit) within ScreenshotAuditSection function rather than extracting to separate file, keeping the three-step flow co-located
  - fpl-draft-candidate-card.tsx exported without 'use client' directive since it is a pure display component with no hooks (parent components are client components)
  - Parse review Confirm button disabled condition gates on all unresolved_slots entries having non-empty correction strings — no bypass path
  - Audit dimensions sorted against DIMENSION_ORDER constant matching backend field names exactly
metrics:
  duration_seconds: 348
  completed_date: "2026-03-30"
  tasks_completed: 3
  files_created: 9
  files_modified: 1
---

# Quick Task 114: WI-0660 Draft Workbench Profile + Build PA Summary

**One-liner:** Seven FPL workbench components (onboarding, draft lab, candidate card, screenshot upload/review, audit, compare) wired into fpl-product-shell.tsx, replacing all placeholder stubs, with two source-text contract test files.

## Tasks Completed

| Task | Name | Commit | Files |
|------|------|--------|-------|
| 1 | Slice A+B — Onboarding, DraftLab, DraftCandidateCard | 075b90d | fpl-onboarding.tsx, fpl-draft-lab.tsx, fpl-draft-candidate-card.tsx |
| 2 | Slice C+D — Screenshot upload/review, Audit, Compare | 978106f | fpl-screenshot-uploader.tsx, fpl-parse-review.tsx, fpl-draft-audit.tsx, fpl-draft-compare.tsx |
| 3 | Wire shell + contract tests | d576106 | fpl-product-shell.tsx, fpl-draft-coach-contract.test.js, fpl-screenshot-audit-contract.test.js |

## Implementation Details

### fpl-onboarding.tsx
6-question form matching OnboardingAnswers exactly: seasons_played (number 0-20), transfer_frequency (radio), primary_goal (radio), risk_appetite (range slider 1-5 labeled Low/High), differential_captains (yes/no toggle), accept_hits (yes/no toggle). Calls createProfile on submit. On success displays archetype badge and constraints summary.

### fpl-draft-candidate-card.tsx
Pure display component. Position pill with GK/DEF/MID/FWD colors (yellow/blue/green/red). Lock (padlock emoji toggle), Ban (x button), Remove button. Locked and banned states show teal/red badges respectively.

### fpl-draft-lab.tsx
Session creation via createDraftSession, add-candidate form (name/team/position/price), candidate list rendered via FPLDraftCandidateCard with lock/ban/remove. Constraint strip: Lock/Ban player inline name inputs, Reduce risk / Favor upside toggle buttons (local riskMode state). Generate squad calls generateDraft, renders rationale + generated_squad. No frontend math.

### fpl-screenshot-uploader.tsx
FileReader.readAsDataURL, strips data-URL prefix to extract pure base64. Up to 3 files. parseScreenshot called automatically on selection. Loading spinner during request.

### fpl-parse-review.tsx
All 15 slots rendered. Confidence bar 0-1. unresolved_slots highlighted with amber border. Correction text input appears for both unresolved and low-confidence (<0.8) slots. Confirm button disabled until corrections Map has a non-empty entry for every slot_index in unresolved_slots. No bypass path.

### fpl-draft-audit.tsx
auditDraft called on mount via useEffect. overall_score as large number + grade badge with color mapping (A=teal, B=green, C=yellow, D=orange, F=red). Dimensions sorted against DIMENSION_ORDER [structure_quality, fixture_quality, minutes_security, volatility, flexibility, profile_fit]. Each dimension: label, 0-10 score bar, rationale, flag chips. top_strengths and top_risks in two small lists.

### fpl-draft-compare.tsx
Two text inputs for session IDs. compareDrafts called on Compare click. overall_winner badge (Session A / Session B / Tie). Per-axis table: dimension, A score, B score, delta (signed, color-coded), winner icon. recommendation in highlighted block. No frontend winner logic.

### fpl-product-shell.tsx
Four placeholder section functions removed. Imports added for all 6 new components. onboarding/build/compare render in max-w-5xl div. screenshot section uses local ScreenshotAuditSection function that orchestrates upload->review->audit three-step state machine with no bypass path. weekly section unchanged.

## Verification Results

- `node web/src/__tests__/fpl-draft-coach-contract.test.js` — 10/10 checks passed, exit 0
- `node web/src/__tests__/fpl-screenshot-audit-contract.test.js` — 6/6 checks passed, exit 0
- `npm run build` — exit 0, no TypeScript or Next.js errors
- fpl-parse-review.tsx references `unresolved_slots` and confirm button disabled condition
- fpl-draft-audit.tsx references `auditDraft` and renders `dimensions` from backend
- fpl-draft-compare.tsx references `overall_winner`, no winner computation logic

## Deviations from Plan

None — plan executed exactly as written.

## Self-Check: PASSED

Files verified present:
- web/src/components/fpl-onboarding.tsx — FOUND
- web/src/components/fpl-draft-lab.tsx — FOUND
- web/src/components/fpl-draft-candidate-card.tsx — FOUND
- web/src/components/fpl-screenshot-uploader.tsx — FOUND
- web/src/components/fpl-parse-review.tsx — FOUND
- web/src/components/fpl-draft-audit.tsx — FOUND
- web/src/components/fpl-draft-compare.tsx — FOUND
- web/src/__tests__/fpl-draft-coach-contract.test.js — FOUND
- web/src/__tests__/fpl-screenshot-audit-contract.test.js — FOUND

Commits verified: 075b90d, 978106f, d576106 — all present in git log.
