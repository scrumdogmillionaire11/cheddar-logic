# ADR-0003: Deprecate Legacy Decision Fields

- Status: Proposed
- Date: 2026-03-07
- Decision Makers: lane/web-platform, lane/data-platform

## Context

The web and worker layers still contain compatibility shims for legacy decision fields
(e.g., `status`, `market`, `pick`, `lean`, `legacy_play`). These shims are used to
repair or interpret historical card payloads and to support older UI logic.

This creates ongoing maintenance overhead:

- Two parallel decision formats (legacy and canonical) require dual-path logic.
- Tests and transforms must keep compatibility fallbacks in sync.
- New behavior must be validated against legacy repair and inference rules.

The canonical decision format is now the primary contract. Legacy fields are
considered transitional and should be retired on a scheduled timeline.

## Decision

Adopt a phased deprecation plan for legacy decision fields. The plan preserves
compatibility during UI migration and removes shims once canonical coverage is complete.

### Timeline

- Phase 1 (by 2026-03-31): Inventory legacy field usage in web and worker, document all
  remaining compatibility paths, and identify the minimal removal set.
- Phase 2 (by 2026-04-30): Migrate UI paths to rely solely on canonical fields where
  possible; keep explicit repair paths for historical payloads only.
- Phase 3 (by 2026-05-31): Remove remaining legacy shims and update tests/fixtures.

## Consequences

- Short term: explicit documentation and test coverage for existing shims.
- Medium term: reduced surface area in transforms, filters, and decision helpers.
- Long term: simpler decision contract with fewer compatibility edges.

## References

- web/src/lib/game-card/transform.ts (legacy repair and inference logic)
- web/src/lib/game-card/decision.ts (legacy action fallback)
- web/src/lib/play-decision/decision-logic.ts (legacy status conversion)
- apps/worker/src/utils/decision-publisher.js (legacy fallback)

