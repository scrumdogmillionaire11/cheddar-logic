# MLB Model Spec

## Scope

This spec covers MLB game-line modeling for:

- F5 moneyline/total run projection
- Full-game total projection
- Full-game moneyline conversion and qualification

## Full-Game Moneyline Architecture

The full-game moneyline path is now explicitly layered:

1. Run creation and prevention

- F5 run means are built from starter quality, offense-vs-handedness splits, park, and weather.
- Full-game extension adds late-innings bullpen run components.
- Full-game and F5 run products remain separate products.

1. Component support extraction

- Starter edge signal from F5 run differential.
- Bullpen edge signal from late-innings differential.
- Offense split edge signal from split-composite deltas.
- Home-field run baseline.

1. Variance-aware win conversion

- Run differential mean is converted to win probability via normal-CDF mapping using explicit run-diff variance.
- Variance term includes run environment, bullpen volatility, weather volatility, HR-profile volatility, and lineup uncertainty flags.

1. Qualification guardrails

- PASS if run differential support is too small.
- PASS if driver support is weak/math-only.
- PASS when expression coherence favors F5 over full game.
- PASS when market sanity checks fail in close-run environments.

## Key Output Fields

`projectFullGameML` returns:

- `p_home_f5`, `p_away_f5`
- `p_home_fg`, `p_away_fg`
- `fair_ml_home`, `fair_ml_away`
- `confidence`
- `driver_support` object
- `flags[]`

These fields are surfaced onto the `full_game_ml` driver card payload for diagnostics and qualification transparency.

## Expression Rules

- Starter-driven edge with weak bullpen differential is treated as F5-preferred.
- Full-game ML may be passed when F5/FG expression coherence is weak.

## Invariants

- No full-game ML promotion on tiny run gaps with weak support.
- Full-game path always includes bullpen context.
- Weak-support math-only edges are explicitly passed with reason codes.
