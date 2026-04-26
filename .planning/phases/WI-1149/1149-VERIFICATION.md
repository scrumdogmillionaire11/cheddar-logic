---
phase: WI-1149-bundle
verified: 2026-04-24T12:35:21Z
status: human_needed
score: 12/12 must-haves verified (automated/code)
human_verification:
  - test: "Mobile layout regression at 375px on /results and /results/projections"
    expected: "No clipping/overflow/regression; filters and tables remain usable"
    why_human: "Viewport rendering quality cannot be fully verified with static code checks"
  - test: "Family control behavior with real production-like projection data"
    expected: "All/NHL 1P/MLB F5 options visibly change both settlement rows and aggregate accuracy cards"
    why_human: "Requires interactive runtime data behavior beyond static verification"
---

# Phase WI-1149 Bundle Verification Report

**Phase Goal:** Verify WI-1149, WI-1146, and WI-1145 are complete to spec (implementation, wiring, and behavioral evidence).
**Verified:** 2026-04-24T12:35:21Z
**Status:** human_needed
**Re-verification:** No — initial verification

## Goal Achievement

### Observable Truths

| # | Truth | Status | Evidence |
| --- | --- | --- | --- |
| 1 | `/results` has betting route metadata/title and `/results/projections` has projection metadata/title | ✓ VERIFIED | `web/src/app/results/layout.tsx:4`, `web/src/app/results/layout.tsx:8`, `web/src/app/results/projections/page.tsx:5`, `web/src/app/results/projections/page.tsx:9` |
| 2 | Betting filters on `/results` are wired into `/api/results` query params | ✓ VERIFIED | `web/src/app/results/page.tsx:215`, `web/src/app/results/page.tsx:216`, `web/src/app/results/page.tsx:217`, `web/src/app/results/page.tsx:221` |
| 3 | `/results` renders betting decision tiers and betting ledger from API payload only | ✓ VERIFIED | `web/src/app/results/page.tsx:248`, `web/src/app/results/page.tsx:249` |
| 4 | Projection family controls exist and are projection-specific | ✓ VERIFIED | `web/src/components/results/ProjectionAccuracyClient.tsx:454`, `web/src/components/results/ProjectionAccuracyClient.tsx:456` |
| 5 | Selecting projection family scopes both settled rows and accuracy metrics | ✓ VERIFIED | `web/src/components/results/ProjectionAccuracyClient.tsx:248`, `web/src/components/results/ProjectionAccuracyClient.tsx:256`, `web/src/components/results/ProjectionAccuracyClient.tsx:577`, `web/src/components/results/ProjectionAccuracyClient.tsx:578`, `web/src/components/results/ProjectionAccuracyClient.tsx:588` |
| 6 | Date/season control omission is explicitly documented due data-contract limits | ✓ VERIFIED | `WORK_QUEUE/WI-1149.md:5` |
| 7 | Canonical confidence resolver is exported from evaluator and reused in settlement flow | ✓ VERIFIED | `apps/worker/src/audit/projection_evaluator.js:197`, `apps/worker/src/audit/projection_evaluator.js:801`, `apps/worker/src/jobs/settle_projections.js:17`, `apps/worker/src/jobs/settle_projections.js:434` |
| 8 | Resolver supports fallback chain including `projection_accuracy.confidence_band` and `drivers[0].confidence_band` | ✓ VERIFIED | `apps/worker/src/audit/projection_evaluator.js:204`, `apps/worker/src/audit/projection_evaluator.js:205` |
| 9 | Settlement tests cover all four required confidence resolution cases | ✓ VERIFIED | `apps/worker/src/jobs/__tests__/settle_projections.test.js:870` |
| 10 | Behavioral tests enforce canonical LOW/MED/HIGH and legacy mapping WATCH/TRUST/STRONG input handling | ✓ VERIFIED | `web/src/__tests__/integration/results-behavioral-contract.test.ts:200`, `web/src/__tests__/integration/results-behavioral-contract.test.ts:201`, `web/src/__tests__/integration/results-behavioral-contract.test.ts:202` |
| 11 | Confidence output assertions check numeric confidencePct and reject legacy labels in API/UI tests | ✓ VERIFIED | `web/src/__tests__/api-results-flags.test.js:171`, `web/src/__tests__/ui-results-smoke.test.js:262`, `web/src/__tests__/integration/results-behavioral-contract.test.ts:357` |
| 12 | Required automated commands execute from repo root and pass (with documented API live-skip mode) | ✓ VERIFIED | Commands executed on 2026-04-24: worker test PASS; `test:results:behavioral-contract` PASS; `test:ui:results` PASS; `test:api:results:flags` PASS (server unavailable/skip path); `web lint` exit 0; `web tsc` exit 0 |

**Score:** 12/12 truths verified (automated/code)

### Required Artifacts

| Artifact | Expected | Status | Details |
| --- | --- | --- | --- |
| `web/src/app/results/layout.tsx` | Betting route metadata/title | ✓ VERIFIED | Metadata title/openGraph title set to Betting Results |
| `web/src/app/results/page.tsx` | Betting-only controls, decision tiers, ledger, betting API wiring | ✓ VERIFIED | Filter params and `fetch('/api/results?...')` wired; segments/ledger rendered from payload |
| `web/src/app/results/projections/page.tsx` | Projection route metadata/title and projection entrypoint | ✓ VERIFIED | Projection metadata and client component mount present |
| `web/src/components/results/ProjectionAccuracyClient.tsx` | Projection family controls and scoped metrics/rows | ✓ VERIFIED | Family controls drive both settled and accuracy data paths |
| `apps/worker/src/audit/projection_evaluator.js` | Canonical confidence resolver with fallback chain + export | ✓ VERIFIED | Resolver includes top-level + projection_accuracy + drivers + score fallback; exported |
| `apps/worker/src/jobs/settle_projections.js` | Settlement uses canonical resolver, no inline duplicate logic | ✓ VERIFIED | Imports resolver and passes resolved bucket into proxy row builder |
| `apps/worker/src/jobs/__tests__/settle_projections.test.js` | Four WI-1145 resolution test cases | ✓ VERIFIED | Case 1-4 tests present and passing |
| `web/src/__tests__/api-results-flags.test.js` | Canonical confidence regression checks | ✓ VERIFIED | Enforces numeric confidencePct/canonical tiers/no legacy confidence labels |
| `web/src/__tests__/ui-results-smoke.test.js` | UI canonical confidence behavior checks | ✓ VERIFIED | Confidence tier derivation and no legacy confidence labels asserted |
| `web/src/__tests__/integration/results-behavioral-contract.test.ts` | Canonical mapping + fallback + API invariant checks | ✓ VERIFIED | Legacy input mapping and missing-signal fallback behavior asserted |

### Key Link Verification

| From | To | Via | Status | Details |
| --- | --- | --- | --- | --- |
| results filter state | `/api/results` | URLSearchParams + fetch query | WIRED | Filter values write `card_category`, `min_confidence`, `market` and fetch uses query string |
| `/api/results` payload | betting UI sections | `setSegments` + `setLedger` | WIRED | Decision tiers and ledger rows update from API data |
| Projection family selector | settled rows | `selectedFamilySet` + `filteredSettledRows` | WIRED | Family button updates selected set and settlement rows |
| Projection family selector | accuracy metrics/rows | `filteredAccuracyRows` + metric summaries | WIRED | Metric cards and breakdown recompute from filtered accuracy rows |
| Settlement worker | confidence bucket resolution | `resolveMoneylineConfidenceBucket({ payload })` | WIRED | Canonical resolver used before proxy eval insert |
| Canonical resolver | legacy payload confidence | `drivers[0].confidence_band` fallback | WIRED | Legacy shape resolved by chain in evaluator |

### Requirements Coverage

| Requirement | Source Plan | Description | Status | Evidence |
| --- | --- | --- | --- | --- |
| WI-1149 acceptance: betting/projections split + titles + controls | `WORK_QUEUE/WI-1149.md` | Distinct views with scoped controls and titles | ✓ SATISFIED | Route metadata and family/filter wiring evidence above |
| WI-1149 acceptance: mobile layout no regressions | `WORK_QUEUE/WI-1149.md` | Mobile UX integrity on both views | ? NEEDS HUMAN | Requires runtime viewport verification |
| WI-1146 acceptance: canonical confidence behavioral tests + no brittle source/html includes patterns | `WORK_QUEUE/WI-1146.md` | Behavioral coverage and test anti-pattern removal | ✓ SATISFIED | Test files include canonical assertions; `rg` guard returned no matches |
| WI-1145 acceptance: canonical resolver reuse and fallback chain + tests | `WORK_QUEUE/WI-1145.md` | Settlement confidence bucket aligned to canonical chain | ✓ SATISFIED | Resolver import/use/export and 4-case tests verified |

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
| --- | --- | --- | --- | --- |
| None | - | No TODO/FIXME/placeholder/stub blocker pattern in scoped WI files | ℹ️ Info | No blocker anti-patterns found |

### Human Verification Required

### 1. Mobile results surfaces

**Test:** Open `/results` and `/results/projections` at 375px width and exercise filters/family controls plus tables/cards.
**Expected:** No clipped controls, no unusable overflow, and content remains readable/actionable.
**Why human:** Visual layout and interaction quality cannot be fully inferred from static code/tests.

### 2. Runtime family switching with realistic data

**Test:** On `/results/projections`, toggle All -> NHL 1P -> MLB F5 family options with populated data.
**Expected:** Settlement rows and accuracy summaries visibly and consistently change together for each selected family.
**Why human:** Depends on live/representative data and interactive rendering behavior.

### Gaps Summary

No automated implementation gaps were found in scoped WI files. All required code/test must-haves are present and wired. Remaining verification is human-only UI/runtime validation.

---

_Verified: 2026-04-24T12:35:21Z_
_Verifier: Claude (gsd-verifier)_
