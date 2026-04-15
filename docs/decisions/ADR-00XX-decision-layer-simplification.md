# ADR-00XX: Decision-Layer Simplification

## Status

Proposed

## Context

Decision outcomes are currently represented across multiple layers with overlapping fields (`status`, `action`, `classification`, `decision_v2.official_status`) and can drift when post-publish overrides occur.

## Decision

Adopt one canonical decision envelope at `decision_v2.canonical_envelope_v2` as the single terminal source for:

- official status
- terminal reason family
- primary reason code
- execution/actionability eligibility

Downstream layers (worker publisher/web transform/filters) consume canonical envelope values and do not recompute terminal verdicts when envelope exists.

## Consequences

Positive:

- Deterministic terminal outcomes
- Cross-layer parity between persisted and surfaced status
- Reduced reason-code fragmentation and easier diagnostics

Tradeoffs:

- Requires migration of legacy fallback reads
- Requires parity tests to guard compatibility

## Migration and Compatibility

1. Produce canonical envelope in model output.
2. Wire publisher to preserve canonical envelope and avoid conflicting status mutations.
3. Web consumes canonical envelope by default.
4. Legacy fallback reads are retained only when canonical envelope is absent and are documented in audit output.

## Verification

- `npm --prefix web run test -- --runInBand src/__tests__/integration/games-pipeline-contract.test.ts`
- Audit report at `docs/audits/decision-layer-parity-audit.md` includes baseline/post-change parity and fragmentation results.
