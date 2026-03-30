---
phase: quick-113
plan: WI-0659
subsystem: web-frontend
tags: [next.js, fpl, product-shell, api-client, typescript]
one-liner: "5-tab FPL product shell replacing single-form /fpl entry, with full API-client coverage for profiles, draft-sessions, screenshot-parse, audit, compare, receipts, and analytics"
depends-on: []
provides:
  - FPLProductShell root component at /fpl
  - fpl-api.ts: 12 new typed endpoint functions and 16 new interfaces covering WI-0653/0654/0655/0656/0657/0658 backend APIs
  - embedded-aware FPLPageClient (weekly flow preserved unchanged)
  - fpl-product-shell-contract.test.js: 58 source-level checks
affects:
  - WI-0660: draft coach UI fills out BuildLabSection and OnboardingSection
  - WI-0661: weekly co-pilot dashboard fills out ScreenshotAuditSection and CompareSection
  - WI-0662: standalone Sage frontend conversion (web/ is now canonical shell)
tech-stack:
  added: []
  patterns:
    - tab-based product shell over existing flow (no regressions)
    - additive API-client extension via append-only exports
    - source-inspection contract test pattern (no runtime dependencies)
key-files:
  created:
    - web/src/components/fpl-product-shell.tsx
    - web/src/__tests__/fpl-product-shell-contract.test.js
  modified:
    - web/src/lib/fpl-api.ts
    - web/src/components/fpl-page-client.tsx
    - web/src/app/fpl/page.tsx
decisions:
  - decision: "Build Lab, Screenshot, and Compare sections scaffolded with placeholder content per out-of-scope boundary; detailed controls land in WI-0660/0661"
    rationale: "WI-0659 explicitly excludes detailed build-lab controls, screenshot correction UI, and weekly dashboard card rendering details"
  - decision: "fpl-page-client.tsx preserved intact, styled for embedded use via a conditional prop rather than a full rewrite"
    rationale: "Avoids a ~400-line duplicate; existing users of FPLPageClient outside the shell are unaffected"
  - decision: "Profile API functions added to fpl-api.ts even though WI-0653 backend was not verified as live; API-client and backend can be activated independently"
    rationale: "WI-0659 acceptance requires fpl-api.ts to support profile endpoints regardless of backend readiness"
metrics:
  duration: "5 minutes"
  completed: "2026-03-30"
  tasks_completed: 5
  tests: "58/58 passed"
---

# Phase quick-113: WI-0659 FPL Product Shell Summary

**Plan:** WI-0659 — Main Next.js FPL product shell and API-client cutover
**One-liner:** 5-tab FPL product shell replacing single-form /fpl entry, with full API-client coverage for profiles, draft-sessions, screenshot-parse, audit, compare, receipts, and analytics

## Objective Achieved

`/fpl` is now the canonical customer-facing FPL surface, exposing five sections (Profile, Build Lab, Squad Audit, Compare, Weekly) via a persistent tab nav. The existing weekly team-ID analysis flow is fully preserved and embedded in the Weekly tab. The product shell is ready for WI-0660/0661 to fill in section-specific controls.

## Tasks Completed

| # | Task | Commit | Files |
|---|------|--------|-------|
| 1 | Extend fpl-api.ts with new endpoint types and functions | a67c47b | web/src/lib/fpl-api.ts |
| 2 | Create fpl-product-shell.tsx with 5-section tab navigation | a67c47b | web/src/components/fpl-product-shell.tsx |
| 3 | Update fpl-page-client.tsx with embedded prop | a67c47b | web/src/components/fpl-page-client.tsx |
| 4 | Update fpl/page.tsx to render FPLProductShell | a67c47b | web/src/app/fpl/page.tsx |
| 5 | Create fpl-product-shell-contract.test.js (58 checks) | a67c47b | web/src/__tests__/fpl-product-shell-contract.test.js |

## New API Client Coverage (fpl-api.ts)

### New Functions

| Function | Endpoint | WI |
|----------|----------|-----|
| `createProfile` | POST /api/v1/profiles | WI-0653 |
| `getProfile` | GET /api/v1/profiles/{userId} | WI-0653 |
| `patchProfile` | PATCH /api/v1/profiles/{userId} | WI-0653 |
| `createDraftSession` | POST /api/v1/draft-sessions | WI-0654 |
| `getDraftSession` | GET /api/v1/draft-sessions/{id} | WI-0654 |
| `generateDraft` | POST /api/v1/draft-sessions/{id}/generate | WI-0654 |
| `parseScreenshot` | POST /api/v1/screenshot-parse | WI-0655 |
| `auditDraft` | POST /api/v1/draft-sessions/{id}/audit | WI-0656 |
| `compareDrafts` | POST /api/v1/draft-sessions/compare | WI-0656 |
| `submitDecisionReceipt` | POST /api/v1/decision-receipts | WI-0658 |
| `getUserAnalytics` | GET /api/v1/user/{id}/analytics | WI-0658 |
| `getUserMemory` | GET /api/v1/user/{id}/memory | WI-0658 |

### New Interfaces (16)

`OnboardingAnswers`, `ManagerConstraints`, `ManagerProfile`, `ProfileCreateRequest`, `ProfilePatchRequest`, `DraftCandidate`, `DraftSession`, `DraftSessionCreateRequest`, `DraftSessionPatchRequest`, `DraftGenerateResponse`, `ParsedSlot`, `ParsedSquad`, `ScreenshotParseRequest`, `ScreenshotParseResponse`, `AuditDimension`, `DraftAuditRequest`, `DraftAuditResponse`, `CompareDraftsRequest`, `CompareDraftsDimension`, `CompareDraftsResponse`, `DecisionDetails`, `DecisionReceiptRequest`, `DecisionReceiptResponse`, `UserAnalyticsResponse`, `DecisionMemorySummary`

## Test Results

```
node web/src/__tests__/fpl-product-shell-contract.test.js

[1] fpl-api.ts required exports          18/18 ✓
[2] fpl-api.ts required interfaces       20/20 ✓
[3] fpl-product-shell.tsx                 9/9  ✓
[4] fpl-page-client.tsx                   4/4  ✓
[5] fpl/page.tsx                          4/4  ✓
[6] Non-regression checks                 3/3  ✓

58 checks: 58 passed, 0 failed

npm run build: success — /fpl listed as ƒ (Dynamic) route
npx tsc --noEmit: exit 0 (clean)
```

## Deviations from Plan

None — plan executed exactly as written. All out-of-scope items (detailed build-lab controls, screenshot correction UI, weekly dashboard card rendering details) are scaffolded with informative placeholders per WI-0659 scope boundary.

## Acceptance Checklist

- [x] `/fpl` is the primary shell for onboarding, build, audit, compare, and weekly views
- [x] `fpl-api.ts` supports profile, draft-session, screenshot-parse, draft-audit, compare, and receipt endpoints
- [x] Existing weekly flow remains reachable inside the new shell (Weekly tab)
- [x] Contract tests verify additive backend capabilities without regressing current FPL entry behavior
- [x] `web/` is the only customer-facing shell; no new customer routes added in `cheddar-fpl-sage/frontend`
- [x] Current weekly entry capability not removed
