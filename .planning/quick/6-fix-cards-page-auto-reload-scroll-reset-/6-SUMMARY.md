---
phase: quick-6
plan: 6
subsystem: web/cards
tags: [ui, ux, cards, scroll, play-suggestion]
dependency_graph:
  requires: []
  provides: [stable-cards-scroll, play-suggestion-ui]
  affects: [web/src/app/cards/page.tsx]
tech_stack:
  added: []
  patterns: [useRef-for-background-refresh, tier-aware-suggestion-styling]
key_files:
  created: []
  modified:
    - web/src/app/cards/page.tsx
decisions:
  - Used useRef instead of a second useState to avoid triggering re-renders on flag change
  - getSuggestionClassName centralizes tier-aware text sizing rather than inline ternary chains
  - NEUTRAL prediction returns null from getPlaySuggestion so no suggestion element is rendered
metrics:
  duration: 72s
  completed: 2026-02-28
  tasks_completed: 2
  files_modified: 1
---

# Phase quick-6 Plan 6: Fix Cards Page Auto-Reload Scroll Reset Summary

Fixed two regressions on the /cards page: silent background refresh using isInitialLoad ref to prevent scroll reset, and a prominent "BET HOME -110" / "BET AWAY +120" Play Suggestion as the dominant visual element in each directional play row.

## What Was Done

### Task 1 — Fix scroll-reset on background refresh (commit: 8cc0fb0)

**Problem:** `setLoading(true)` was called unconditionally inside `fetchGames`, which ran on both initial mount and every 30-second setInterval tick. Each time `loading` flipped to `true`, the content block (`{!loading && games.length > 0 && ...}`) unmounted, the DOM collapsed, and scroll position reset to the top.

**Fix:**
- Added `const isInitialLoad = useRef(true)` to the component
- `setLoading(true)` is now guarded: `if (isInitialLoad.current) { setLoading(true); }`
- `isInitialLoad.current = false` is set in the `finally` block so the first fetch flips it
- Updated subtitle text from "auto-refreshes every 30 seconds" to "updates in background every 30s"
- Added `useRef` to the React import

**Behavior after fix:** Initial page load shows the "Loading games..." spinner as before. All subsequent interval ticks update `games` state silently — no loading state, no DOM unmount, no scroll jump.

### Task 2 — Add prominent Play Suggestion to each play row (commit: 742c8cb)

**Problem:** The plays section showed tier badges, prediction, confidence, and reasoning but buried the actionable bet direction. Users had to infer what to do from metadata rather than seeing a clear call-to-action.

**Fix — two new helpers:**

```tsx
const getPlaySuggestion = (play: Play, odds: GameData['odds']): string | null => {
  if (!odds) return null;
  if (play.prediction === 'HOME') return `BET HOME ${formatOddsLine(odds.h2hHome)}`;
  if (play.prediction === 'AWAY') return `BET AWAY ${formatOddsLine(odds.h2hAway)}`;
  return null; // NEUTRAL
};

const getSuggestionClassName = (tier: Play['tier']): string => {
  if (tier === 'SUPER') return 'text-lg font-bold text-green-200 tracking-wide mb-1';
  if (tier === 'BEST') return 'text-base font-bold text-green-300 tracking-wide mb-1';
  return 'text-sm font-bold text-green-300/80 tracking-wide mb-1';
};
```

**Play row updated** to render suggestion as first child before badges:
```tsx
{suggestion && (
  <p className={getSuggestionClassName(play.tier)}>
    {suggestion}
  </p>
)}
```

**Tier-aware sizing:**
- SUPER: `text-lg text-green-200` — largest, brightest
- BEST: `text-base text-green-300` — standard green
- WATCH/null: `text-sm text-green-300/80` — subdued (directional WATCH plays still show a suggestion if HOME/AWAY)
- NEUTRAL: no suggestion rendered at all

## Verification

- TypeScript: `cd web && npx tsc --noEmit` — zero errors in `cards/page.tsx` (pre-existing error in auto-generated `.next/dev/types/validator.ts` for unrelated `api/cards/[gameId]/route` is out of scope)
- Scroll fix: `isInitialLoad.current` ensures `setLoading(true)` is not called on interval ticks; content block stays mounted; scroll position preserved
- Play Suggestion: `getPlaySuggestion` returns non-null only for HOME/AWAY; rendered with tier-aware Tailwind classes as first element of the play row

## Deviations from Plan

None — plan executed exactly as written.

## Self-Check

**Task commits exist:**
- 8cc0fb0 — fix(quick-6): prevent scroll reset on background refresh using isInitialLoad ref
- 742c8cb — feat(quick-6): add prominent Play Suggestion line to each play row

**File exists:** web/src/app/cards/page.tsx — FOUND

## Self-Check: PASSED
