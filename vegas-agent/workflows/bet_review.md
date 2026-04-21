# Workflow: Bet Review

Use this as the default VEGAS entry point for a single bet.

## Audit Levels

### GATE_CHECK

`GATE_CHECK` is the mandatory pre-flight verification level.

- Run `workflows/pre_flight.md` first.
- If it emits `PASS - [REASON_CODE]: [sentence].`, stop here.
- If it emits `GATE_CHECK: CLEAR`, proceed to `STANDARD_AUDIT`.

### STANDARD_AUDIT

`STANDARD_AUDIT` is implemented by `## Audit Sequence` below.

Boundary rules:

- `STANDARD_AUDIT` consumes post-gate candidate state.
- It must not recreate gate-failure logic unless resolver flow delivered new data.
- Undefined audit-level synonyms are disallowed unless explicitly mapped to a defined level.

Status note:

Watchdog enforcement behavior is downstream implementation work in WI-1034-b and WI-1034-c.

## Inputs

- bet type and side
- market price and timestamp
- projected probability / fair line
- supporting rationale and source quality

## Audit Sequence

1. Define the exact bet being proposed.
2. Capture current market price and implied probability.
3. Compute projected edge and EV.
4. List supporting signals.
5. List contradictory signals.
6. Identify missing or uncertain inputs.
7. Run red-flag scan.
8. Assign final verdict.

## Verdict Rules

- `PLAY`: clear edge, explainable thesis, no major red flags.
- `LEAN`: slight edge or moderate uncertainty with required companion `verification_state`.
- `PASS`: edge weak, unproven, or unclear.
- `FADE`: thesis likely wrong or risk mispriced.

Strict `LEAN` semantics:

- `LEAN + verification_state=PENDING` = verification-blocked candidate.
- `LEAN + verification_state=CLEARED|NOT_REQUIRED` = true Slight Edge lean.

If gate verification fails, emit `PASS - [REASON_CODE]: [sentence].`.

## Required Output

- short thesis
- edge summary
- contradictions
- missing-data impact
- risk notes
- final verdict (`PLAY` / `LEAN` / `PASS` / `FADE`)
- verification state (`NOT_REQUIRED` / `PENDING` / `CLEARED` / `FAILED` / `EXPIRED`)
