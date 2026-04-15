# Decision Layer Parity Audit

## Scope

- `packages/models/src/decision-pipeline-v2.js`
- `apps/worker/src/utils/decision-publisher.js`
- `apps/worker/src/jobs/run_nhl_model.js`
- `apps/worker/src/jobs/run_nba_model.js`
- `web/src/lib/games/route-handler.ts`
- `web/src/lib/game-card/transform/index.ts`
- `web/src/lib/game-card/filters.ts`

## Baseline

Document baseline counts before changes:

- reason-family/code fragmentation count:
- number of fallback-only web verdict paths:
- parity mismatches in games-pipeline integration test:

## Post-change Results

Document post-change counts:

- reason-family/code fragmentation count:
- fallback-only web verdict paths remaining:
- parity mismatches in games-pipeline integration test:

## Deterministic Checks

- `rg -n "canonical_envelope_v2|terminal_reason_family|primary_reason_code" packages/models/src apps/worker/src web/src`
- `rg -n "official_status\s*=|classification\s*=|action\s*=" apps/worker/src/utils/decision-publisher.js apps/worker/src/jobs/run_nhl_model.js apps/worker/src/jobs/run_nba_model.js web/src/lib/game-card/filters.ts`
- `npm --prefix web run test -- --runInBand src/__tests__/integration/games-pipeline-contract.test.ts`

## Findings

- [ ] No cross-layer terminal-status disagreement for canonical-envelope payloads.
- [ ] No sampled blocked payload surfaced as actionable when canonical envelope exists.
- [ ] Residual compatibility fallback locations listed explicitly.

## Residual Debt Ledger

- Debt ID
- Type (`code` | `contract` | `diagnostic` | `documentation`)
- Artifact
- Decision (`removed` | `retained-intentional`)
- Rationale
- Follow-up WI (if retained)
