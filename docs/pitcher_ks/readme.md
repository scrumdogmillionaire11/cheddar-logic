# Sharp Cheddar K — MLB Pitcher-K Projection Engine

A structured projection engine for MLB pitcher strikeouts. Current runtime is `PROJECTION_ONLY` only: it estimates a K mean, emits a Poisson ladder and fair-price thresholds, and forces PASS rows because no live line is ingested.

---

## What this system is

Sharp Cheddar K is a projection-first, trap-aware strikeout engine. It takes pitcher and matchup inputs, runs them through a defined pipeline, and outputs a projection package with explicit PASS diagnostics. Every step is documented, codified, and testable.

The engine does not chase lines. It does not romance small samples. It does not emit executable plays without a verified market line. In the current runtime path, all cards are PASS-only research rows.

---

## What this system is not

This is not a model that scrapes public picks or follows sharp money. It is not a CLV-chasing system — prop markets are too illiquid for CLV to be a reliable signal. It is not a narrative tool. Stories don't score.

---

## Required inputs

Before the engine runs, the following data must be confirmed present. See `docs/08_data_requirements.md` for full spec.

| Input | Source |
|-------|--------|
| Pitcher K% / SwStr% (season + rolling windows when available) | Baseball Savant / FanGraphs |
| Expected innings pitched | Starting rotation depth charts |
| Pitch count last 3 starts | Baseball Reference / game logs |
| Opponent K% vs. handedness (last 30 days) | FanGraphs team splits |
| Opponent OBP / xwOBA / hard-hit profile vs. handedness | FanGraphs / Savant team splits |
| Umpire K rate | UmpScorecards.com |
| Weather (if outdoor park) | Weather.com / Weatherball |
| Park factor (K environment) | FanGraphs park factors |
| Pitcher IL status / rest days | MLB transaction wire |

Market lines are intentionally not a required input in WI-0733. DraftKings/FanDuel/OddsTrader/OddsJam sourcing is deferred to a separate work item because there is no clean free structured pitcher-K odds API.

---

## Pipeline overview

```
Raw K projection
      ↓
Leash classification
      ↓
Overlay layer (trend / ump / BvP)
      ↓
Poisson ladder + fair thresholds
      ↓
Trap detection
      ↓
Confidence scoring (0–10)
      ↓
Projection-only PASS verdict + diagnostics
```

Full pipeline detail: `docs/01_process_overview.md`

---

## Output format

Every evaluated prop produces a structured verdict. See `docs/07_output_format.md` for the full template.

```
## Pick
[Pitcher] Ks PASS [PROJECTION_ONLY]

## Projection
[X.X] Ks

## Distribution
P(5+)=[x.xx], P(6+)=[x.xx], P(7+)=[x.xx]

## Fair thresholds
Over playable at <= [x.x]
Under playable at >= [x.x]

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
PASS — `PASS_PROJECTION_ONLY_NO_MARKET`
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

**Projection first.** No overlay, market signal, or gut read overrides a projection with no model support.

**Leash is structural.** A fake leash makes the over fake. No amount of positive overlay compensates for a ceiling on innings pitched.

**Kill samples that don't qualify.** BvP below 30 PA, ump below 30 GP, trend below 4 starts — all score zero. Not estimated. Zero.

**Trap detection is a program step, not a gut check.** It runs every time. It has defined triggers. It produces a binary result.

**PASS-only until market sourcing is trustworthy.** Confidence metadata can be logged, but runtime cards must not become actionable until a separate line ingestion WI lands.

---

## Version

Engine version: 1.0
Last updated: 2026-03-25
