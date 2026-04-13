# Endpoint Parity Matrix (WI-0902)

This audit documents fixture-driven behavioral parity between cards and games endpoint normalization logic.

## Scope

- `web/src/app/api/cards/route.ts`
- `web/src/app/api/cards/[gameId]/route.ts`
- `web/src/lib/games/route-handler.ts`
- `web/src/__tests__/api-endpoint-parity-fixtures.test.js`

## Diff Schema

Each fixture emits a deterministic diff object:

```json
{
  "gameId": "...",
  "fixtureId": "...",
  "cards": {
    "status": "PLAY|LEAN|PASS|NO_BET",
    "reason_code": "string|null",
    "visibility_class": "visible|hidden",
    "has_projection_marker": true
  },
  "games": {
    "status": "PLAY|LEAN|PASS|NO_BET",
    "reason_code": "string|null",
    "visibility_class": "visible|projection_only",
    "has_projection_marker": true
  },
  "field_deltas": ["visibility_class"],
  "reason_explanation": "...",
  "parity_status": "MATCH|EXPECTED_DELTA|UNEXPECTED_DELTA"
}
```

## Expected Delta Contract

Projection-only payloads intentionally diverge:

- cards path excludes them from default betting surface (`visibility_class = hidden`)
- games path includes them as projection-only context (`visibility_class = projection_only`)

This difference must be labeled `EXPECTED_DELTA`, never silently ignored.

## Failure Rule

Any fixture producing `UNEXPECTED_DELTA` must fail the suite with non-zero exit.

## Fixture Interpretation

- `MATCH`: status, reason, visibility, and projection marker behavior align
- `EXPECTED_DELTA`: divergence is intentional, documented, and field-scoped
- `UNEXPECTED_DELTA`: unplanned behavioral drift; requires remediation
