---
phase: market-board
plan: 01
type: execute
wave: 1
depends_on: []
files_modified:
  - web/src/app/wedge/page.tsx
  - web/src/app/cards/page.tsx
  - web/src/app/page.tsx
  - web/src/components/cards/CardsHeader.tsx
  - web/src/components/play-of-the-day-client.tsx
  - web/src/components/global-stale-asset-guard.tsx
autonomous: true
requirements: [WEDGE-01]

must_haves:
  truths:
    - "Navigating to /wedge renders the picks page (same content as /cards today)"
    - "Navigating to /cards redirects to /wedge (no 404 for bookmarked users)"
    - "Homepage nav shows The Wedge linking to /wedge"
    - "The picks page header reads The Wedge, not The Cheddar Board"
    - "Play-of-the-day CTA links to /wedge, not /cards"
  artifacts:
    - path: "web/src/app/wedge/page.tsx"
      provides: "The Wedge page route"
      contains: "CardsPageClient"
    - path: "web/src/app/cards/page.tsx"
      provides: "Backwards-compatible redirect"
      contains: "redirect('/wedge')"
    - path: "web/src/app/page.tsx"
      provides: "Updated nav with /wedge link"
      contains: "href=\"/wedge\""
    - path: "web/src/components/cards/CardsHeader.tsx"
      provides: "Updated page heading"
      contains: "The Wedge"
  key_links:
    - from: "web/src/app/page.tsx"
      to: "/wedge"
      via: "Link href"
      pattern: "href=\"/wedge\""
    - from: "web/src/app/cards/page.tsx"
      to: "/wedge"
      via: "Next.js redirect()"
      pattern: "redirect.*wedge"
---

<objective>
Rename the picks surface from /cards to /wedge. Reserve Cheddar Board naming for the standalone /board market-intelligence surface in Plan 02.

Purpose: The picks page is now called The Wedge. This plan is URL and label rename only, with zero picks-logic changes.
Output: /wedge route serving the same CardsPageClient and /cards permanently redirecting.
</objective>

<execution_context>
@/Users/ajcolubiale/.claude/get-shit-done/workflows/execute-plan.md
@/Users/ajcolubiale/.claude/get-shit-done/templates/summary.md
</execution_context>

<context>
@.planning/STATE.md
@web/src/app/page.tsx
@web/src/app/cards/page.tsx
@web/src/components/cards/CardsHeader.tsx
@web/src/components/play-of-the-day-client.tsx
@web/src/components/global-stale-asset-guard.tsx
</context>

<tasks>

<task type="auto">
  <name>Task 1: Create /wedge route, redirect /cards, and update header label</name>
  <files>
    web/src/app/wedge/page.tsx,
    web/src/app/cards/page.tsx,
    web/src/components/cards/CardsHeader.tsx
  </files>
  <action>
    Create web/src/app/wedge/page.tsx by copying current cards/page.tsx and updating metadata title/url to The Wedge.
    Replace web/src/app/cards/page.tsx with a redirect to /wedge.
    Update CardsHeader h1 text to The Wedge.
  </action>
  <verify>
    curl -s -o /dev/null -w "%{http_code}" http://localhost:3000/wedge
    curl -s -o /dev/null -w "%{http_code}" http://localhost:3000/cards
  </verify>
  <done>
    /wedge returns 200, /cards redirects, and header reads The Wedge.
  </done>
</task>

<task type="auto">
  <name>Task 2: Update nav links and route guards for The Wedge</name>
  <files>
    web/src/app/page.tsx,
    web/src/components/play-of-the-day-client.tsx,
    web/src/components/global-stale-asset-guard.tsx
  </files>
  <action>
    Update homepage nav link from /cards to /wedge and rename label to The Wedge.
    Update Play-of-the-day CTA href and related label references from /cards/Cards to /wedge/The Wedge.
    Update global stale asset guard route check from startsWith('/cards') to startsWith('/wedge').
  </action>
  <verify>
    ! rg -n 'href="/cards"' web/src --glob '!**/__tests__/**' --glob '!**/*.test.*'
  </verify>
  <done>
    No non-test source files link directly to /cards. Homepage and POTD CTA point to /wedge.
  </done>
</task>

</tasks>

<verification>
- npm --prefix web run build passes
- /wedge loads the same picks surface
- /cards redirects to /wedge
</verification>

<success_criteria>
- /wedge fully functional
- /cards redirects to /wedge
- Homepage and CTA route to /wedge
- Picks page heading reads The Wedge
- No active non-test href references to /cards
</success_criteria>

<output>
After completion, create .planning/phases/market-board/market-board-01-SUMMARY.md
</output>
