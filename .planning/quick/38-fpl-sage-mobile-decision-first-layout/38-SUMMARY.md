---
phase: 38-fpl-sage-mobile-decision-first-layout
plan: "01"
subsystem: fpl-dashboard
tags: [mobile, responsive, ux, fpl, tailwind]
dependency_graph:
  requires: []
  provides:
    - decision-first-mobile-layout
    - collapsible-advanced-sections
    - sticky-mobile-header
    - scaled-pitch-player-cards
  affects:
    - web/src/components/fpl-dashboard.tsx
    - web/src/components/fpl-lineup-view.tsx
tech_stack:
  added: []
  patterns:
    - React useState for collapsible section toggle per section
    - Tailwind order-N / md:order-none for CSS-only mobile reorder
    - Tailwind responsive prefix stacking: w-[72px] min-[380px]:w-[96px] sm:w-[132px] md:w-[168px]
    - Sticky mobile header with backdrop-blur (sticky top-0 z-10 block md:hidden)
    - Collapsible sections: mobile toggle button md:hidden, content hidden md:block when closed
key_files:
  created: []
  modified:
    - web/src/components/fpl-dashboard.tsx
    - web/src/components/fpl-lineup-view.tsx
decisions:
  - Used CSS order utilities (order-1 through order-6 with md:order-none) rather than DOM reorder to keep desktop layout driven by source order and avoid duplicating JSX
  - Collapsible sections use hidden/show pattern ({open ? 'px-4 pb-4' : 'hidden md:block ...'}) rather than CSS display:none so deferred content is not rendered in DOM when collapsed
  - Strategy Notes section duplicates the Decision Brief content on mobile as a collapsible summary rather than removing it — preserves all source text contracts
  - min-[380px] custom breakpoint used for intermediate card size since Tailwind has no xs by default
metrics:
  duration: "3 minutes"
  completed_date: "2026-03-14"
  tasks_completed: 2
  tasks_total: 2
  files_modified: 2
---

# Quick Task 38: FPL Sage Mobile Decision-First Layout Summary

**One-liner:** Decision-first responsive FPL dashboard with sticky mobile header, CSS order-based module reorder, six collapsible advanced sections, and 72px-base scaled pitch player cards for 320px viewports.

## Tasks Completed

| # | Task | Commit | Files |
|---|------|--------|-------|
| 1 | Responsive mobile layout with sticky header and collapsible advanced sections | f619029 | web/src/components/fpl-dashboard.tsx |
| 2 | Full-width mobile pitch and scaled player cards | 1f4fe86 | web/src/components/fpl-lineup-view.tsx |

## What Was Built

### Task 1: fpl-dashboard.tsx

- **Sticky mobile header** (`block md:hidden`, `sticky top-0 z-10`) showing GW number, team name (truncated), free transfer count badge, and captain name. Minimum height 56px with `px-4 py-3`.
- **Three-breakpoint outer wrapper**: `flex flex-col gap-6 xl:block xl:space-y-8` — mobile single-column stack, xl+ reverts to block/space-y-8 for desktop.
- **Mobile module order via CSS utilities**: Transfers `order-1`, Captaincy `order-2`, FPLLineupView wrapper `order-3`, Decision Brief / Manager State / Chip Strategy `order-4`, Strategy Notes `order-5`, advanced sections (Planner, Near Threshold, Strategy Paths, Structural Issues, Risk Notes) `order-6`. All have `md:order-none` applied.
- **Six collapsible sections** with individual `useState` booleans (all default `false`). Each has a `button` toggle (`md:hidden`) with chevron indicator (`▸`/`▾`) meeting `min-h-[44px]`. Content uses `hidden md:block` when closed so deferred table DOM is not rendered.
- **Padding**: section wrappers use `p-4 md:p-8`.
- **All source text contracts preserved** — all strings checked by the three contract tests remain verbatim in the file.

### Task 2: fpl-lineup-view.tsx

- **Player card width scaling**: `w-[72px] min-[380px]:w-[96px] sm:w-[132px] md:w-[168px]` — 4-DEF row at 320px = 288px + gaps, no overflow.
- **Card text scaling**: player name `text-[10px] sm:text-sm md:text-[1.05rem]`, team/pos `text-[9px] sm:text-[11px]`, pts `text-[10px] sm:text-sm md:text-[1.05rem]`.
- **C/VC badge padding**: `pr-7 sm:pr-9` to keep badge clearance proportional at narrow widths.
- **Player row gaps**: `gap-1 sm:gap-2` on pitch position rows (was `gap-2 sm:gap-3`).
- **View toggle touch targets**: `px-3 py-2 min-h-[44px] sm:px-4` on both Current/Recommended buttons.

## Verification

All three contract tests pass:

```
node web/src/__tests__/fpl-dashboard-strategy.test.js        ✅
node web/src/__tests__/fpl-lineup-formation-contract.test.js  ✅
node web/src/__tests__/fpl-dashboard-fixture-planner.test.js  ✅
```

## Deviations from Plan

None — plan executed exactly as written.

## Self-Check: PASSED

- `web/src/components/fpl-dashboard.tsx` — exists, modified
- `web/src/components/fpl-lineup-view.tsx` — exists, modified
- Commit f619029 — confirmed in git log
- Commit 1f4fe86 — confirmed in git log
- All three contract tests exit 0
