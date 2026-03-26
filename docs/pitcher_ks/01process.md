# 01 — Process overview

The Sharp Cheddar K engine runs every pitcher strikeout prop through a six-step pipeline. Steps are sequential and gated — a failed gate at any step can halt evaluation before the next step runs. No step is optional. No step is reordered.

---

## Step 1 — Raw K projection

**What happens:** Build a number-of-strikeouts projection from first principles using three inputs: pitcher K/9, expected innings pitched, and opponent strikeout environment. Apply a contact cap if the matchup indicates balls will be put in play at a rate that suppresses Ks.

**Gate:** If projection cannot be calculated (missing K/9, unconfirmed lineup, or IP is unknown due to role ambiguity), evaluation halts. No projection = no play.

**Key rule:** The projection is independent of the market line at this stage. Do not look at the line before completing Step 1. Looking at the line first invites anchoring.

**Output:** A single projected K total (e.g., 7.2 Ks).

Full spec: `docs/02_projection_formula.md`

---

## Step 2 — Leash classification

**What happens:** Classify the pitcher's expected workload ceiling into one of four tiers — Full, Mod+, Mod, or Short — based on recent pitch count data. Apply IL flag or extended-rest flag if applicable.

**Gate:** If leash = Short on an over, or if IL/extended-rest flag is active on an over, evaluation halts. The structural ceiling makes the over invalid regardless of projection margin.

**Key rule:** Leash classification is determined by recent pitch count history and organizational role context. A manager pulling a pitcher at 75 pitches for bullpen reasons is a different signal than a pitcher who hasn't gone deep all season.

**Output:** Leash tier (Full / Mod+ / Mod / Short) and any active flags.

Full spec: `docs/03_leash_rules.md`

---

## Step 3 — Overlay layer

**What happens:** Apply up to three qualified overlays — trend, umpire, and BvP — each of which can add signal if the underlying sample meets the minimum qualification threshold. Unqualified samples score zero. No estimation. No partial credit.

**Gate:** No gate at this step — overlay totals can be zero and evaluation continues. Zero overlay score simply reduces the confidence ceiling.

**Key rule:** Overlays confirm or reinforce the projection. They do not create edge where the projection has none. A strong overlay on a marginal projection is still a marginal play.

**Output:** Overlay scores (0–3 total) and disqualification notes for any overlay that failed the sample threshold.

Full spec: `docs/04_overlay_rules.md`

---

## Step 4 — Market comparison

**What happens:** Compare the projection to the current market line to calculate the margin. Apply the directional market check — is the line moving with or against the play? Note the vig differential if applicable.

**Gate:** If margin is below the minimum floor for the side (0.5K over, 0.75K under), evaluation halts. No margin = no play. Thin edges are not played.

**Key rule:** Under requires a larger margin than over at every tier. This reflects the structural over-bias books build into the prop market. Betting the under into a tight margin means fighting both the book and the market design.

**Output:** Margin (projection minus line), market movement direction, confidence block score for market structure.

Full spec: `docs/05_market_tiers.md`

---

## Step 5 — Trap detection

**What happens:** Run a structured scan across six trap categories: public bias, hidden role risk, market movement anomaly, lineup context gaps, weather, and park environment. Each category is evaluated as a binary — flag or no flag.

**Gate:** Two or more active trap flags suspend scoring entirely. The play is logged as "environment compromised" and no verdict is issued. One trap flag scores Block 5 as zero but does not halt scoring.

**Key rule:** Ask why the line exists before asking if the line is wrong. A play that looks too easy probably is. Assume bait before assuming value when the line is soft and the narrative is clean.

**Output:** Trap flag count and category list. Block 5 score (0 or 1).

Full spec: `docs/06_trap_detection.md`

---

## Step 6 — Final call

**What happens:** Run the confidence scoring model across all five blocks, apply any penalties, and produce a net score. Map the net score to a confidence tier. Issue the verdict (Play, Conditional, Pass) and assign unit size.

**Gate:** If net score is below 5 after penalties, verdict is Pass. If any kill-switch was triggered in Steps 1–5, no verdict is issued — the play was already halted upstream.

**Key rule:** Confidence and unit size are outputs of the logic, not inputs to it. The decision is made before sizing. Sizing follows the decision.

**Output:** Confidence score (0–10), tier label, verdict, unit size.

Full spec: `rules/confidence_rules.md`

---

## Pipeline gate summary

| Step | Gate condition | Action |
|------|---------------|--------|
| Step 1 | Projection uncalculable | Halt — no play |
| Step 1 | Block 1 = 0 (no margin) | Halt — no play |
| Step 2 | Short leash on over | Halt — structural ceiling |
| Step 2 | IL / extended rest on over | Halt — structural ceiling |
| Step 4 | Margin below floor | Halt — no play |
| Step 5 | Two+ trap flags | Suspend — environment compromised |
| Step 6 | Net score < 5 | Pass verdict |

---

## What does not happen in this pipeline

- The line is not consulted before the projection is complete
- Overlays are not used to justify plays with no projection margin
- Public sentiment, recency bias, and narrative are not inputs at any step
- Unit size is not decided before the confidence score is known
- A play is never issued when a kill-switch has fired