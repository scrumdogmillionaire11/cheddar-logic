# Endpoint Behavioral Parity Audit

**WI-0902 | Created: 2026-04-12**

This document describes the fixture matrix, expected behavioral diffs, and
interpretation rules for the endpoint parity suite at
`web/src/__tests__/api-endpoint-parity-fixtures.test.js`.

---

## Purpose

The `/api/cards` and `/api/games` endpoints serve the same underlying card
payloads through different response contracts. This audit documents every
known difference between those contracts, so future changes can be evaluated
against a stable baseline rather than causing silent drift.

---

## Fixture Matrix

| fixtureId | Scenario | Expected parity_status | Expected field_deltas |
|---|---|---|---|
| parity-001-standard-play | Standard PLAY decision with ODDS_BACKED basis | MATCH | — |
| parity-002-standard-lean | Standard LEAN decision with ODDS_BACKED basis | MATCH | — |
| parity-003-projection-only | PROJECTION_ONLY basis/execution_status/prop_display_state | EXPECTED_DELTA | visibility_class |
| parity-004-synthetic-fallback | `line_source: synthetic_fallback`, `projection_source: SYNTHETIC_FALLBACK` | EXPECTED_DELTA | visibility_class |
| parity-005-pass-with-reason | PASS decision with explicit pass_reason_code | MATCH | — |
| parity-006-blocked | BLOCKED execution_status, NO_BET official_status | MATCH | — |
| parity-007-nested-play | PLAY via nested `play` sub-object | MATCH | — |
| parity-008-projection-floor | `line_source: projection_floor` | EXPECTED_DELTA | visibility_class, has_projection_marker |

---

## Diff Schema

Each fixture produces a diff object with the following keys:

| Key | Type | Meaning |
|---|---|---|
| `gameId` | `string` | Synthetic game identifier for this fixture |
| `fixtureId` | `string` | Stable fixture identifier (matches table above) |
| `cards` | `object` | Behavioral fields derived via the cards path |
| `games` | `object` | Behavioral fields derived via the games path |
| `field_deltas` | `string[]` | Names of fields that differ between `cards` and `games` |
| `reason_explanation` | `string` | Human-readable explanation of any delta |
| `parity_status` | `"MATCH" \| "EXPECTED_DELTA" \| "UNEXPECTED_DELTA"` | Classification of this diff |

### Behavioral fields (within `cards` and `games`)

| Field | Type | Derivation |
|---|---|---|
| `status` | `string` | `decision_v2.official_status` → `action` → `verdict`. Normalized to: PLAY / LEAN / PASS / NO_BET / DEGRADED |
| `reason_code` | `string \| null` | `decision_v2.primary_reason_code` → `pass_reason_code` |
| `visibility_class` | `"visible" \| "hidden" \| "projection_only"` | See visibility logic below |
| `has_projection_marker` | `boolean` | True when `projection_source === SYNTHETIC_FALLBACK`, `prop_display_state === PROJECTION_ONLY`, or `visibility_class === projection_only` |

---

## Visibility Logic

### Cards path (`/api/cards`)

The cards route calls `isBettingSurfacePayload()` to determine whether a card
should appear in the response at all:

- Returns `false` (card excluded) when any of these conditions are true:
  - `decision_basis_meta.decision_basis === 'PROJECTION_ONLY'`
  - `execution_status === 'PROJECTION_ONLY'`
  - `prop_display_state === 'PROJECTION_ONLY'`
  - `line_source IN ('projection_floor', 'synthetic', 'synthetic_fallback')`
  - `prop_decision.projection_source === 'SYNTHETIC_FALLBACK'`

In the parity harness, payloads excluded by `isBettingSurfacePayload` receive
`visibility_class = "hidden"` rather than `"projection_only"`. This is an
intentional semantic distinction: the cards path does not classify what kind
of row was filtered, it simply removes it.

### Games path (`/api/games`)

The games route normalizes payload fields and includes projection-only rows
in the response with explicit classification:

- `execution_status: PROJECTION_ONLY` → row included, classified as projection-only
- `basis: PROJECTION_ONLY` → same
- `prop_display_state: PROJECTION_ONLY` → same
- `line_source IN PROJECTION_ONLY_LINE_SOURCES` → same

In the parity harness, payloads matching these conditions receive
`visibility_class = "projection_only"`.

---

## Interpreting parity_status

### `MATCH`

Both paths produce identical behavioral fields for this payload. A refactor
that produces `UNEXPECTED_DELTA` where this fixture expects `MATCH` indicates
behavioral drift that must be explained before merging.

### `EXPECTED_DELTA`

The paths produce different behavioral fields for this payload. The delta is
documented and expected. The `field_deltas` array lists which fields differ
and `reason_explanation` explains why.

**Do not "fix" expected deltas without updating this document and the fixture
table simultaneously.** Changing expected deltas without documentation means
the parity suite loses its value as an audit trail.

### `UNEXPECTED_DELTA`

The parity suite will **fail** when it encounters this status. This means a
field differs between the cards and games paths in a way that was not
anticipated when the fixture was written. The diff will be printed to stdout.

When this happens:
1. Read the printed diff carefully.
2. Determine whether the delta is correct behavior (a new architectural
   difference) or a bug.
3. If correct: update the fixture to mark it `EXPECTED_DELTA` and add the
   field to `expectedFieldDeltas`. Update this document.
4. If a bug: fix the route or payload normalization that introduced the drift.

---

## Known Expected Deltas

### `visibility_class`: cards="hidden" vs games="projection_only"

**Fixtures:** parity-003, parity-004, parity-008

**Root cause:** Architectural difference in how each endpoint handles
projection-only payloads:
- `/api/cards` **excludes** projection-only rows entirely before returning.
  The parity harness labels excluded rows as `visibility_class="hidden"`.
- `/api/games` **includes** projection-only rows with explicit classification.
  The parity harness labels these as `visibility_class="projection_only"`.

**Why this is correct:** The two endpoints serve different consumers with
different UX requirements. Cards is a betting dashboard that only shows
actionable rows. Games shows all upcoming games including ones with no live
market, so it must include projection-only rows to present a complete game
listing.

### `has_projection_marker`: cards=false vs games=true (fixture parity-008)

**Fixture:** parity-008-projection-floor

**Root cause:** The cards path assigns `has_projection_marker=false` to a
`projection_floor` row because the marker-assignment logic runs after the
visibility check. Since the row is filtered out by `isBettingSurfacePayload`
before the marker is computed, the parity harness sees no marker.

The games path computes `has_projection_marker=true` because it classifies
the row as projection-only and assigns the marker explicitly.

---

## How to Add a New Fixture

1. Open `web/src/__tests__/api-endpoint-parity-fixtures.test.js`.
2. Add a new object to `FIXTURE_TABLE` with:
   - A stable `fixtureId` (format: `parity-NNN-descriptive-name`)
   - A deterministic `gameId` (format: `game-parity-NNN`)
   - A `scenario` string describing what behavioral case this tests
   - A minimal `payload` that exercises the case
   - `expectedParity` with `status`, `reasonCode`, `visibilityClass`,
     `hasProjectionMarker`, `expectedParityStatus`, and `expectedFieldDeltas`
3. Run `node web/src/__tests__/api-endpoint-parity-fixtures.test.js` to
   confirm the new fixture passes.
4. If the fixture is `EXPECTED_DELTA`, add a row to the Fixture Matrix above
   and document the delta in the Known Expected Deltas section.
5. Commit both the test file change and this document update together.

---

## Test Execution

```
node web/src/__tests__/api-endpoint-parity-fixtures.test.js
```

The suite exits with code 0 on success, code 1 if any `UNEXPECTED_DELTA` is
detected. The diff object is printed to stdout on failure.
