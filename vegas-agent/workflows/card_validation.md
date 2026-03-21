# Workflow: Card Validation

Use for multi-bet slate review before placement.

## Inputs

- full card with prices and stake sizes
- projected edges per play
- correlation map (explicit or inferred)

## Validation Steps

1. Confirm each leg has independent edge evidence.
2. Remove legs that are projection-only without explanation.
3. Check duplicate thesis risk across correlated bets.
4. Check total slate exposure against cap.
5. Stress-test downside if top assumptions fail.
6. Reclassify each leg to `PLAY` / `LEAN` / `PASS` / `FADE`.

## Output

- approved plays
- downgraded or rejected plays with reason codes
- total exposure summary
- concentration warnings
