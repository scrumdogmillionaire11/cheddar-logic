# Sharp Cheddar K — MLB Strikeout Prop Engine

A structured decision engine for evaluating MLB pitcher strikeout props (overs and unders). Built to eliminate narrative reasoning, enforce signal discipline, and produce repeatable, auditable verdicts.

---

## What this system is

Sharp Cheddar K is a projection-first, trap-aware strikeout prop engine. It takes pitcher and matchup inputs, runs them through a defined pipeline, and outputs a scored verdict with explicit confidence and unit size. Every step is documented, codified, and testable.

The engine does not chase lines. It does not romance small samples. It does not issue verdicts without margin. It does not play through traps it has identified.

---

## What this system is not

This is not a model that scrapes public picks or follows sharp money. It is not a CLV-chasing system — prop markets are too illiquid for CLV to be a reliable signal. It is not a narrative tool. Stories don't score.

---

## Required inputs

Before the engine runs, the following data must be confirmed present. See `docs/08_data_requirements.md` for full spec.

| Input | Source |
|-------|--------|
| Pitcher K/9 (season + rolling 4-start) | Baseball Savant / FanGraphs |
| Expected innings pitched | Starting rotation depth charts |
| Pitch count last 3 starts | Baseball Reference / game logs |
| Opponent K% vs. handedness (last 30 days) | FanGraphs team splits |
| Opponent lineup (confirmed, not projected) | Beat reporters / official lineup cards |
| Market line (opening + current) | Pinnacle / DraftKings / FanDuel |
| Umpire K rate | UmpScorecards.com |
| Weather (if outdoor park) | Weather.com / Weatherball |
| Park factor (K environment) | FanGraphs park factors |
| Pitcher IL status / rest days | MLB transaction wire |

---

## Pipeline overview

```
Raw K projection
      ↓
Leash classification
      ↓
Overlay layer (trend / ump / BvP)
      ↓
Market comparison
      ↓
Trap detection
      ↓
Confidence scoring (0–10)
      ↓
Final verdict + unit size
```

Full pipeline detail: `docs/01_process_overview.md`

---

## Output format

Every evaluated prop produces a structured verdict. See `docs/07_output_format.md` for the full template.

```
## Pick
[Pitcher] o/u [line] Ks

## Projection
[X.X] Ks

## Margin
[+/-X.X] Ks

## Leash
[Full / Mod+ / Mod / Short]

## Overlays
- Trend: [positive / neutral / negative]
- Ump: [boost / neutral / suppressor]
- BvP: [boost / neutral / insufficient sample]

## Confidence score
[X/10] — [Tier label]

## Trap check
[Pass / Flag: reason]

## Verdict
[Play / Conditional / Pass] — [X.Xu]
```

---

## Folder structure

```
sharp-cheddar-k/
├── README.md
├── docs/
│   ├── 01_process_overview.md
│   ├── 02_projection_formula.md
│   ├── 03_leash_rules.md
│   ├── 04_overlay_rules.md
│   ├── 05_market_tiers.md
│   ├── 06_trap_detection.md
│   ├── 07_output_format.md
│   └── 08_data_requirements.md
├── data_specs/
│   ├── pitcher_input_schema.md
│   ├── matchup_input_schema.md
│   ├── umpire_schema.md
│   └── market_line_schema.md
├── examples/
│   ├── over_examples.md
│   ├── under_examples.md
│   ├── pass_examples.md
│   └── trap_examples.md
├── prompts/
│   ├── system_prompt.md
│   ├── evaluator_prompt.md
│   └── summary_prompt.md
├── rules/
│   ├── confidence_rules.md
│   ├── scoring_rules.md
│   ├── bvp_escalator.md
│   └── guardrails.md
├── tests/
│   ├── golden_cases.md
│   ├── edge_cases.md
│   └── expected_outputs.md
└── changelog.md
```

---

## Design principles

**Projection first.** No overlay, market signal, or gut read overrides a projection with no margin. If the edge isn't in the number, it isn't anywhere.

**Leash is structural.** A fake leash makes the over fake. No amount of positive overlay compensates for a ceiling on innings pitched.

**Kill samples that don't qualify.** BvP below 30 PA, ump below 30 GP, trend below 4 starts — all score zero. Not estimated. Zero.

**Trap detection is a program step, not a gut check.** It runs every time. It has defined triggers. It produces a binary result.

**Confidence is earned, not assumed.** The scoring model rewards independent confirming signals. It penalizes structural headwinds. It does not round up.

---

## Version

Engine version: 1.0
Last updated: 2026-03-25
