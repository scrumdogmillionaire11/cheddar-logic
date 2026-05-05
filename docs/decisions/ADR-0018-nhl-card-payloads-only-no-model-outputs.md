# ADR-0018: NHL model outputs remain card_payloads-only (no model_outputs writes)

- Status: Accepted
- Date: 2026-05-04
- Work item: WI-1222

## Context

The NHL runner (`apps/worker/src/jobs/run_nhl_model.js`) writes decision payloads to
`card_payloads` and intentionally does not write rows to `model_outputs`.

MLB, NFL, and FPL model runners write to `model_outputs` through
`insertModelOutput()`, and the web read route `/api/model-outputs` exposes that
surface.

Because NHL behavior was previously documented only in source comments and
implementation details, downstream consumers could assume NHL parity with
MLB/NFL/FPL and treat missing NHL rows as an incident.

## Decision

NHL remains `card_payloads`-only for betting output persistence.

- `run_nhl_model.js` does not call `insertModelOutput()`.
- `/api/model-outputs` does not include NHL rows by design.
- Route and contract tests must explicitly document and enforce this asymmetry.

## Trade-offs

- Pros:
  - Keeps NHL aligned with its card-first pipeline and existing downstream
    consumers that read card payloads.
  - Avoids dual-write complexity and schema drift risk while NHL uses this
    delivery path.
- Cons:
  - Cross-sport read symmetry is reduced because NHL is absent from
    `model_outputs`.
  - Consumers that expect one shared table for all sports need explicit
    documentation and guardrails.

## Consequences

- API consumers must treat `sport=nhl` on `/api/model-outputs` as expected to
  return no NHL writer rows.
- Regression tests must fail if NHL is added to the writer set or if route
  documentation drifts from this decision.
- No runtime/API response contract changes are introduced by this ADR itself.

## Rollback / Unification Plan

If product requirements later require NHL parity in `model_outputs`:

1. Add NHL writer support in `run_nhl_model.js` using `insertModelOutput()` with
   a stable row contract.
2. Add/adjust migrations only if required for NHL-specific fields.
3. Update `/api/model-outputs` route docs and writer contract tests to include
   NHL explicitly.
4. Ship with a backfill/migration plan for historical NHL records if needed,
   and announce contract changes to downstream consumers.
5. Supersede this ADR with a new accepted ADR documenting parity semantics.
