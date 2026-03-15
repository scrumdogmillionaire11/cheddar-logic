---
phase: 41-display-play-type-label-on-cards
plan: "01"
subsystem: web/ui
tags: [card, ui, label, quick-task]
dependency_graph:
  requires: []
  provides: [cardType pill in Signal Header Bar]
  affects: [web/src/components/card.tsx]
tech_stack:
  added: []
  patterns: [conditional JSX rendering, Tailwind truncate]
key_files:
  modified:
    - web/src/components/card.tsx
decisions:
  - Placed cardType pill between sport badge and card title so it is visible immediately on scan without reordering the existing badge or title
  - Used max-w-[160px] truncate to prevent long slugs from overflowing narrow viewports
  - Preserved recommended_bet_type in play block — header chip is for scanning; play block is for detail
metrics:
  duration_minutes: 5
  completed: "2026-03-14"
  tasks_completed: 1
  tasks_total: 1
  files_changed: 1
---

# Quick Task 41: Display Play-Type Label on Cards Summary

## One-liner

Added `cardType` slug pill and `recommended_bet_type` chip to the Signal Header Bar so users can orient to segment+market at a glance.

## What Was Done

The `Card` component accepted a `cardType` prop via `CardProps` but never destructured or rendered it. `recommended_bet_type` existed only in the play block detail section.

Two pills were added to the left-side flex group of the Signal Header Bar, between the sport badge and the card title `<h3>`:

1. **cardType pill** — `font-mono`, `text-slate-400`, `bg-slate-800/60`, `border-slate-700/50`, `max-w-[160px] truncate`. Renders the segment+model slug (e.g., `nhl-pace-totals`).
2. **recommended_bet_type chip** — `font-mono`, `text-slate-500`, `bg-slate-800/40`, `uppercase`. Renders the market type (e.g., `TOTAL`, `SPREAD`).

Both elements are conditional — no empty pill is rendered when the value is absent. The existing `recommended_bet_type` display in the play block was not touched.

## Commits

| Hash | Message |
|------|---------|
| 74383e8 | feat(41-01): add play-type label pill to Signal Header Bar |

## Deviations from Plan

None — plan executed exactly as written.

## Self-Check: PASSED

- File modified: `web/src/components/card.tsx` — confirmed
- Build: `next build` exits 0 with no TypeScript errors — confirmed
- Commit 74383e8 exists — confirmed
