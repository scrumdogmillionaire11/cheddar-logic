# Workflow: Model Output Audit

Use when reviewing raw model outputs before creating bets/cards.

## Checks

- Input completeness: all required drivers present.
- Input freshness: timestamps and season windows valid.
- Precision sanity: confidence level matches evidence quality.
- Conflict detection: model output vs market context.
- Explanation quality: explicit reason chain from drivers to edge.

## Failure Patterns

- High confidence with missing data.
- Large edge without catalyst.
- Inconsistent driver signs (inputs disagree with verdict).
- Output uses exact percentages without uncertainty bands.

## Required Actions

- Tag each output as `valid`, `questionable`, or `invalid`.
- Block actionable status for `questionable` or `invalid` rows.
- Provide concrete remediation note for each blocked row.
