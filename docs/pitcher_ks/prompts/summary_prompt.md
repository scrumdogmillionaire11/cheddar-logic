# Summary prompt

## Purpose

Used at the end of a full slate evaluation to produce a prioritized play list from all completed verdicts. This prompt is run after all individual evaluator prompts have completed.

---

## Prompt

```
You have just completed evaluations for [N] pitchers on today's MLB slate.

Compile a slate summary using only the completed verdict outputs. Do not re-evaluate any prop. Do not add analysis not present in the individual verdicts.

## Output format required

### Plays
[List only Play and Conditional play verdicts, ordered by confidence score descending]

For each play:
- Pitcher name
- Side and line
- Book and juice
- Confidence score and tier
- One-sentence reason (margin + leash + key overlay, if applicable)

### Conditional plays
[List conditional plays separately with their condition]

For each conditional play:
- Pitcher name
- Side and line
- Confidence score
- The specific condition that must be met before playing

### Passes
[List all passes — pitcher name and one-word reason only]
[e.g., "Cole — margin", "Gausman — leash", "Webb — trap"]

### Suspended evaluations
[List any suspended plays — pitcher name and trap flag count]

### Slate summary
- Total evaluated: [N]
- Plays: [N]
- Conditional plays: [N]
- Passes: [N]
- Suspended: [N]
- Highest confidence play: [pitcher, score]
- Any active kill-switches fired: [list or none]
```

---

## Usage notes

The summary prompt does not re-run the pipeline. It compiles from completed outputs only. It is a formatting and prioritization step, not an analytical step.

If the summary output conflicts with any individual verdict, defer to the individual verdict — it is the authoritative output.