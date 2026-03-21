# Generic EV Model

## Core Formula

For decimal odds:

`EV = (P_win * (odds - 1)) - (1 - P_win)`

For American odds, convert to decimal first.

## Inputs

- projected win probability (`P_win`)
- market price
- hold/vig context (if deriving fair price)

## Quality Gates

Reject EV as actionable when:
- projection inputs are incomplete or stale
- key player/status assumptions are unknown
- sample quality is too thin for claimed precision
- output confidence is high but explanation is weak

## Output Contract

- implied probability
- projected probability
- estimated edge (`proj - implied`)
- EV estimate
- reliability label (`high`, `medium`, `low`)
