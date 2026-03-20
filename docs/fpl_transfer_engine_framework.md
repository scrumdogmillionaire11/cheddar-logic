# FPL Transfer Recommendation Engine Framework (Canonical)

Version: v1.0 (WI-0513)
Owner: GitHub Copilot
Status: Implementation-ready planning spec

## 1) Objective

Define a value-first transfer recommendation framework that reduces over-reliance on safe-start + short-form bias while preserving hard squad legality and blank/DGW guardrails from WI-0512.

## 2) Decision Factors

### 2.1 Must-have factors (required in MVP ranking)

| Factor | Definition | Rationale | Data source | Failure mode | Fallback |
| --- | --- | --- | --- | --- | --- |
| Expected points (short + medium horizon) | $xPts_h = \sum_{gw \in h} P(start) \cdot E[pts\mid started]$ for $h \in \{3,5\}$ GW | Core outcome metric for transfer utility | FPL API player/fixture data + model projections | Missing fixture-linked projection rows | Backfill with rolling position baseline + fixture-adjusted prior |
| Value efficiency | $Value_h = xPts_h / Price$ | Surfaces underpriced picks; primary anti-template signal | FPL API price + computed $xPts_h$ | Price snapshot stale near deadline | Recompute at run time; otherwise use latest sell-price cache with freshness flag |
| Minutes/security risk (soft) | Continuous risk penalty from $P(start)$ and uncertainty, not a hard 75% gate | Keeps rotation-risk players discoverable while pricing risk | Minutes history, injury flags, team-news confidence | News missing or stale | Increase uncertainty penalty coefficient and emit low-confidence badge |
| Fixture quality + blank/DGW handling | Fixture score over horizon with explicit BGW exclusion and DGW uplift | Captures schedule context and avoids blank traps | FPL fixtures API + WI-0512 blank/DGW safeguards | Reschedule mismatch / incomplete fixture map | Use official FPL fixture fallback and mark schedule confidence low |
| Hit economics (net gain after cost) | $NetHitGain = xPts_{in,h} - xPts_{out,h} - 4 \cdot nHits$ | Prevents low-EV paid transfers | Squad state + computed projections | Outgoing replacement projection absent | Use conservative outgoing baseline and require higher confidence to pass |

### 2.2 Nice-to-have factors (v2+)

| Factor | Definition | Rationale | Data source | Failure mode | Fallback |
| --- | --- | --- | --- | --- | --- |
| Ownership dynamics | Blend of TSB and short-term ownership delta | Differential/context signal | FPL ownership fields | Ownership feed lag | Ignore ownership term for run and mark neutral |
| Role context | Set-piece/penalty/advanced role boosts | Improves ceiling modeling | Tagged role data | Role tag unavailable | Default role multiplier to 1.0 |
| Team strength trend | Team attack/defense rolling form | Better fixture-context calibration | Team xG/xGA trends | Partial team metrics | Use league/position priors |
| Variance profile | Player points dispersion and haul probability | Supports risk-mode strategy | Historical point distribution | Sparse history for new players | Use position-level variance prior |

## 3) Scoring Formula Candidates

### 3.1 Core score candidate (Balanced mode)

$$
Score(p,h) =
0.35\,Norm(xPts_h)
+0.30\,Norm(Value_h)
+0.15\,Norm(Fixture_h)
-0.12\,MinutesRisk(p)
+0.08\,DGWBoost_h
-0.06\,HitPenalty_h
$$

Notes:
- Value is first-class (second-largest weight and used as tie-break primary).
- `MinutesRisk` is continuous (soft) and can be amplified by uncertainty.
- `HitPenalty_h` is zero for free transfer actions.

### 3.2 Horizon blending candidate

$$
xPts_{blend} = 0.65\,xPts_{3GW} + 0.35\,xPts_{5GW}
$$

Use `xPts_blend` for default ranking, with a strategy override for aggressive/conservative modes.

### 3.3 Minutes/security risk candidate (soft replacement for hard 75% gate)

$$
MinutesRisk = \alpha\,(1-P(start)) + \beta\,Uncertainty + \gamma\,InjuryVolatility
$$

Suggested MVP defaults:
- $\alpha=0.70$, $\beta=0.20$, $\gamma=0.10$
- Hard exclusion only for explicit unavailable/out statuses (not for generic low start probability)

### 3.4 Hit economics candidate

$$
HitScore = NetHitGain - \lambda\,DownsideRisk
$$

Recommend paid transfer only when:
- $NetHitGain > 0$ and
- confidence tier is `medium` or `high`

## 4) Guardrails (Hard exclusions + soft warnings)

### 4.1 Hard exclusions (must fail closed)

- Invalid transfer legality (budget, position constraints, team-size/team-cap limits).
- Explicit unavailable/out injury status.
- Confirmed blank gameweek for the specific horizon gameweek slot.
- Incomplete minimum projection payload after fallback attempts.

### 4.2 Soft risk treatment (replaces hard 75% start gate)

- No hard exclusion solely from low `P(start)`.
- Apply continuous minutes risk penalty with confidence tags:
  - `high-risk`: large penalty + clear explainability warning.
  - `medium-risk`: moderate penalty.
  - `low-risk`: minimal penalty.
- If uncertainty is high and inputs are stale, down-rank and annotate, do not auto-block.

## 5) Missing Data and Fallback Behavior

Evaluation order:
1. Primary projection input.
2. Horizon prior (recent + season blend).
3. Position/team prior.
4. Exclude with reason when all fallback tiers fail.

Output requirements per candidate:
- `data_confidence`: high/medium/low
- `fallback_tier_used`: none/tier1/tier2/tier3
- `missing_inputs`: explicit machine-readable list

## 6) Explainability Output Contract

Each recommendation must emit:
- Top 2 positive drivers (example: `value_efficiency`, `fixture_quality`).
- Top 1 risk driver (example: `minutes_uncertainty`).
- Net economics line for hit decisions (`xPts in/out`, hit cost, net).
- Confidence and fallback provenance.

Template:
- `why_text`: short human-readable summary.
- `why_codes[]`: stable machine-friendly codes.
- `risk_badges[]`: `minutes-risk`, `injury-risk`, `schedule-risk`, etc.

## 7) Phased Implementation Plan

### MVP
- Implement must-have factors + balanced score.
- Replace hard 75% start-probability gating with continuous minutes risk penalty.
- Preserve WI-0512 blank/DGW constraints.
- Emit explainability + fallback metadata.

MVP acceptance checks:
- Ranking output includes value in top-level scoring breakdown.
- No hard rejection solely for low start probability.
- Hard exclusion reasons are explicit and legal/safety related.

### v2
- Add role/ownership/variance factors.
- Add strategy modes (balanced, conservative, aggressive).
- Add richer confidence calibration.

v2 acceptance checks:
- Distinct strategy rankings are reproducible.
- Confidence calibration error decreases vs MVP.

### v3
- Add learned weight calibration + manager risk personalization.
- Add richer scenario simulation around chips and horizon selection.

v3 acceptance checks:
- Out-of-sample backtest improvement over MVP/v2 baseline.

## 8) Verification Plan

### 8.1 Offline backtest KPIs

- Net points gain vs baseline per GW.
- Hit ROI distribution (mean and downside tail).
- Regret rate (`outgoing` outperforming `incoming` over horizon).
- Value capture metric (share of recommendations in top value decile).
- Calibration of confidence vs realized outcome.

### 8.2 Online A/B metrics

- Primary: average GW point delta per manager cohort.
- Secondary: hit acceptance quality, regret rate, confidence calibration drift.
- Guardrail: rollback trigger if sustained negative delta over threshold window.

## 9) Regression Tests Derivable from This Spec

1. Candidate with low `P(start)` but high value is down-ranked (not hard-excluded) when availability is healthy.
2. Candidate with explicit unavailable status is hard-excluded regardless of value.
3. Blank-GW candidate is excluded for affected horizon slot while non-blank horizon evaluation still functions.
4. Paid transfer with negative `NetHitGain` is rejected with explicit economics reason.
5. Missing projection input falls through fallback tiers and emits `fallback_tier_used` + `missing_inputs`.
6. Explainability output includes at least 2 positive drivers + 1 risk driver + confidence tag.

## 10) Engineering Handoff Notes

- Keep implementation scope in runtime code for a follow-up WI (this document is planning-only).
- Preserve existing API contracts unless explicitly re-scoped in a later WI.
- Treat this markdown as canonical handoff reference; HTML companion is presentation-oriented.