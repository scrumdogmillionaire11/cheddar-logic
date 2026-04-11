---
phase: WI-0870
plan: WI-0870-per-page-metadata
subsystem: web-ui
tags: [next.js, metadata, og-tags, seo, link-sharing]
status: complete

dependency-graph:
  requires: []
  provides:
    - per-page title tags on all 12 public routes
    - og:title and og:description per route
    - generateMetadata for education/[slug] using article.title + article.summary
    - results/layout.tsx Server Component wrapper for client-only results page
  affects: []

tech-stack:
  added: []
  patterns:
    - Next.js 15 Metadata API (export const metadata / export async function generateMetadata)
    - Server Component layout wrapper for client-component pages

key-files:
  created:
    - web/src/app/results/layout.tsx
  modified:
    - web/src/app/page.tsx
    - web/src/app/cards/page.tsx
    - web/src/app/analytics/page.tsx
    - web/src/app/play-of-the-day/page.tsx
    - web/src/app/subscribe/page.tsx
    - web/src/app/fpl/page.tsx
    - web/src/app/education/page.tsx
    - web/src/app/education/[slug]/page.tsx

decisions:
  - id: legal-pages-already-had-metadata
    summary: disclaimer, privacy, and terms pages already exported metadata; left untouched (no change needed)
  - id: results-layout-wrapper
    summary: results/page.tsx is 'use client' so cannot export metadata; created results/layout.tsx as Server Component wrapper

metrics:
  duration: ~8m
  completed: "2026-04-10"
---

# Phase WI-0870: Per-page Metadata for Link Sharing Summary

**One-liner:** Next.js Metadata API `export const metadata` added to 8 public routes + `generateMetadata` on education/[slug] + new `results/layout.tsx` wrapper; all 12 routes have unique og:title and og:description.

## Tasks Completed

| Task | Description | Commit |
|---|---|---|
| 1 | Add per-page metadata to all 9 scoped server-component pages; add generateMetadata to education/[slug]; create results/layout.tsx | f15c368 |

## Verification

- `npm --prefix web run build` passes cleanly
- All 12 routes compile and render (static + dynamic + SSG confirmed in build output)
- No page UI or behavior changed (metadata-only additions)

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Discovery] Legal pages already had metadata — skipped**

- **Found during:** Initial file audit
- **Issue:** `web/src/app/legal/disclaimer/page.tsx`, `privacy/page.tsx`, and `terms/page.tsx` each already exported `metadata` with title and description. Plan listed them as needing additions.
- **Fix:** Skipped modification of legal pages; all other pages proceeded as planned.
- **Files modified:** None (no change to legal pages)

## Next Phase Readiness

No blockers. This WI is a standalone UI enhancement with no downstream dependencies.
