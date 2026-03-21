# Workflow: Bet Review

Use this as the default VEGAS entry point for a single bet.

`EDGE VERIFICATION REQUIRED` is mandatory for this workflow.

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
- `LEAN`: slight edge or moderate uncertainty.
- `PASS`: edge weak, unproven, or unclear.
- `FADE`: thesis likely wrong or risk mispriced.

If edge verification cannot be completed, force `PASS`.

## Required Output

- short thesis
- edge summary
- contradictions
- missing-data impact
- risk notes
- final verdict (`PLAY` / `LEAN` / `PASS` / `FADE`)
