# Canonical Play-State Contract

**Status**: Active
**Introduced**: 2026-04-25 (supersedes v1 contract language)
**Owner**: Decision authority module
(`packages/models/src/decision-authority.js`)

---

## Problem This Solves

Play state had been re-derived in multiple places from competing fields
(`action`, `classification`, `status`, `decision_v2.official_status`,
`final_play_state`). That created split-brain outputs across worker,
web reads, Discord, and POTD.

The fix is a single authority object written by worker and consumed
downstream with fail-closed behavior in active read paths.

---

## Canonical Decision Object

`resolveCanonicalDecision(payload)` emits the canonical decision object:

- `official_status`: `'PLAY' | 'SLIGHT_EDGE' | 'PASS'`
  Authority-level verdict.
- `is_actionable`: `boolean`
  True for `PLAY` and `SLIGHT_EDGE`; false for `PASS`.
- `tier`: `'PLAY' | 'SLIGHT_EDGE' | 'PASS'`
  Alias of `official_status`.
- `reason_code`: `string`
  Primary reason for current authority verdict.
- `source`: `'decision_authority'`
  Must be stamped by authority flow.
- `lifecycle`: `DecisionStage[]`
  Stage trail (`parser`, `model`, `publisher`, `watchdog`, `read_api`).

Lifecycle statuses are normalized to `CLEARED`, `DOWNGRADED`, `BLOCKED`,
or `PASS`.

---

## Pipeline Envelope Mapping

Worker preserves canonical authority while also publishing
pipeline-compatible fields:

- Authority status: `payload.canonical_decision.official_status` uses
  `PLAY/SLIGHT_EDGE/PASS`.
- Pipeline status: `payload.decision_v2.official_status` uses
  `PLAY/LEAN/PASS`.
- Canonical envelope: `payload.decision_v2.canonical_envelope_v2` carries both:
  - `official_status` (`PLAY/LEAN/PASS`)
  - `authority_status` (`PLAY/SLIGHT_EDGE/PASS`)
  - `source`, `lifecycle`, `primary_reason_code`, `reason_codes`,
    `is_actionable`, `execution_status`, `publish_ready`

Status mapping is fixed:

- `PLAY` -> `PLAY`
- `SLIGHT_EDGE` -> `LEAN`
- `PASS` -> `PASS`

---

## Resolver Behavior

Location: `packages/models/src/decision-authority.js`

Resolution order:

1. Enforce source contract when `strictSource=true`.
2. Prefer explicit canonical status from `canonical_decision.official_status`.
3. Fall back to `decision_v2.official_status`.
4. Only when explicitly allowed (`fallbackToLegacy=true`), map legacy
  display fields.
5. Normalize lifecycle entries and append fallback stage if needed.

Default for read paths is fail-closed: if no canonical status exists and
legacy fallback is disabled, resolver returns `null`.

---

## Write-Time Responsibilities

Worker publish path (`apps/worker/src/utils/decision-publisher.js`) is
authoritative for stamping:

- `payload.canonical_decision`
- `payload.decision_v2.canonical_envelope_v2`
- `payload.decision_v2.source = 'decision_authority'`
- normalized `payload.decision_v2.official_status`

`applyDecisionVeto()` remains terminal and stamps blocked/pass semantics
so downstream surfaces cannot reopen a play.

---

## Read-Time Fail-Closed Rules (Active Mode)

1. `/api/cards`: no active-mode global run fallback when scoped query is empty.
2. `/api/games`: projection-surface `decision_v2` synthesis is rejected
  in active mode.
3. `/api/results` projection metrics: no implicit
  action/classification fallback when canonical statuses are missing.
4. Web display decision prefers canonical envelope status first;
  legacy-only rows can still render for non-canonical historical
  compatibility.

---

## Downstream Consumption Rules

1. Discord bucketing consumes canonical decision first, then compatibility
  fallback only when canonical data is absent.
2. POTD payloads stamp canonical decision source and reason explicitly
  for emitted cards.
3. Wave-1 web reads must not manufacture decision truth from legacy
  fields when canonical fields are missing.

---

## Invariants

1. Canonical decision source is `decision_authority`.
2. Authority verdict vocabulary is exactly `PLAY/SLIGHT_EDGE/PASS`.
3. Pipeline verdict vocabulary is exactly `PLAY/LEAN/PASS`.
4. Mapping between vocabularies is deterministic and one-way.
5. Active read APIs fail closed when canonical status is absent.
6. Legacy fallback is compatibility-only, never active truth synthesis.

---

## Tests

- `packages/models/src/__tests__/decision-authority-lifecycle.test.js`
- `web/src/__tests__/decision-authority-single-source.test.ts`
- `web/src/__tests__/api-cards-no-global-fallback-active.test.ts`
- `web/src/__tests__/api-results-no-implicit-actionable-fallback.test.ts`
- `web/src/__tests__/api-games-reject-legacy-fallback-active.test.ts`
