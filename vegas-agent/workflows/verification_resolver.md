# Workflow: Verification Resolver

The resolver consumes pending verification requirements and transitions candidate verification state.

## Resolver Loop

1. Load candidate with `verification_state=PENDING` and pending requirements.
2. For each pending requirement, dispatch the requirement `action_type`.
3. Persist fetched evidence and update requirement status to `CLEARED` or `FAILED`.
4. Recompute candidate-level verification state (`PENDING`, `CLEARED`, `FAILED`, `EXPIRED`).
5. Emit terminal-state output and dispatch to the correct downstream layer.

## Action Dispatch

Supported actions:

- `FETCH_MARKET_SNAPSHOT`
- `FETCH_BEST_LINE`
- `FETCH_STARTER_STATUS`
- `FETCH_LINEUP_STATUS`
- `FETCH_WEATHER_STATUS`
- `REPRICE_MODEL`
- `RECHECK_MOVEMENT_WINDOW`
- `MARK_EXPIRED`

## Terminal State Contract

### CLEARED

- Emit: resolver-cleared event including `CandidateVerification`.
- Dispatch target: audit layer entry for `STANDARD_AUDIT` eligibility.
- Important: `CLEARED` means eligible for re-evaluation only; it does not auto-emit `PLAY`.

### FAILED

- Emit: `PASS - [blocker_code]: [failure_reason].`
- Dispatch target: user-facing output channel; processing stops for this candidate.

### EXPIRED

- Emit: `PASS - EXPIRED: Verification window closed without resolution.`
- Dispatch target: user-facing output plus archival storage; processing stops for this candidate.

## Output Semantics

Resolver output must preserve strict LEAN semantics:

- `LEAN + verification_state=PENDING` = blocked pending verification.
- `LEAN + verification_state=CLEARED|NOT_REQUIRED` = true Slight Edge lean.
