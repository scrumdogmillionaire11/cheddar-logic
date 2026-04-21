# Workflow: GATE_CHECK

`GATE_CHECK` is the formal pre-flight audit level. It runs before `STANDARD_AUDIT`.

Run checks in this exact order:

1. Price freshness
2. Starter confirmed (MLB/NHL)
3. Adverse line movement

## Check 1: Price Freshness

Rule:

- Current best-available line must be within configured drift threshold of the signal price.
- Default example threshold is 5 cents, configurable by sport and market.

Fail code:

- `PRICE_STALE`

## Check 2: Starter Confirmed

Rule:

- Starting pitcher or goalie must be confirmed.
- Confirmed starter must match priced assumption.

Fail codes:

- `STARTER_UNCONFIRMED`
- `STARTER_MISMATCH`

## Check 3: Line Movement Direction

Rule:

- Market must not move against the signal side beyond configured adverse threshold since signal generation.
- Default example threshold is 5 cents, configurable by sport and market.

Fail code:

- `LINE_MOVE_ADVERSE`

## Output Contract

On first failure (user-facing output only):

- `PASS - [REASON_CODE]: [sentence].`

On all checks passing:

- `GATE_CHECK: CLEAR`

No other output is emitted by this workflow.

## Internal-State Guidance

User-facing output is first-fail for brevity.

Internal state may still collect all cheap-to-detect blockers in the same pass for telemetry, debugging, and retry prioritization.
