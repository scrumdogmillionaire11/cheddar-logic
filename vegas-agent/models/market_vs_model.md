# Market vs Model

## Core Test

Evaluate model disagreement against market in three steps:

1. Measure gap (`model_prob - market_implied_prob`).
2. Explain gap with specific drivers.
3. Stress-test whether drivers are already priced.

## Interpretation

- Market >> Model: default assumption is model omission.
- Model >> Market: possible edge, but validate input integrity first.
- Tiny gap + high model certainty: likely fake precision.

## Required Checks Before Action

- projection recency confirmed
- injury/news assumptions confirmed
- correlation and duplication risk reviewed
- contradictory signals documented
