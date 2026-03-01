---
type: quick
priority: high
estimated_effort: "30% context"
autonomous: true
files_modified:
  - frontend/src/components/CaptaincySection.tsx
  - frontend/src/components/TransferSection.tsx
  - frontend/src/components/ChipDecision.tsx
  - frontend/src/pages/Results.tsx
  - backend/services/result_transformer.py
---

# Quick Task: Enhance Analysis Output with Deeper Insights

## Objective

Enhance the analysis results display to provide FPL users with more valuable, actionable insights beyond basic recommendations. Currently showing captain picks, transfers, and chip decisions - but users need DEEPER reasoning to trust and act on the recommendations.

**Purpose:** Transform the results from "what to do" into "what to do AND why it matters" by surfacing contextual insights already available in the data.

**Output:** Enhanced results UI with fixture context, ownership leverage, form trends, and timing rationale.

## Context

**Current state (what users see):**
- Captain: Name + expected points + basic rationale
- Transfers: OUT → IN with delta points and reason
- Chips: Recommendation + timing
- Squad: Starting XI + bench with expected points

**Gap:** The analysis lacks CONTEXT that makes recommendations meaningful:
- WHY is this captain pick valuable (fixture difficulty, form, ownership angle)?
- WHEN is the optimal time to make this transfer (deadline pressure, price changes)?
- HOW does this chip usage compare to other gameweeks (opportunity cost)?
- WHAT are the fixture swings driving these decisions?

**Available data (not currently surfaced):**
- Fixture difficulty and opponent strength
- Ownership percentages (for differential/template plays)
- Form trends (recent performance)
- Price change momentum
- Multi-gameweek projections (4GW, 6GW windows)
- Risk scenarios and injury concerns

## Tasks

<task type="auto">
<name>Add fixture and form context to captaincy display</name>

<files>
frontend/src/components/CaptaincySection.tsx
backend/services/result_transformer.py
</files>

<action>
Enhance captain recommendations with fixture and ownership context:

**Backend (result_transformer.py):**
1. In `_transform_captain()`, enrich captain data with:
   - Fixture difficulty indicator (if available from raw_data)
   - Ownership leverage calculation (ownership_pct for differential vs template decision)
   - Form indicator from next6_pts trend

2. Add new helper `_calculate_ownership_insight()`:
   - < 10% ownership: "Huge differential - high risk, high reward"
   - 10-30%: "Quality differential option"
   - 30-60%: "Balanced ownership"
   - 60-80%: "Template pick - safe floor"
   - > 80%: "Essential - avoid mass rank drops"

**Frontend (CaptaincySection.tsx):**
1. Below captain name/team, add contextual badges:
   - Fixture indicator: "🎯 Great matchup" / "⚠️ Tough fixture" based on opponent strength
   - Ownership badge with insight text
   - Form trend: "🔥 Hot form (X pts/game avg)" if recent form is strong

2. Expand rationale to include:
   - Fixture context: "Faces [opponent] at home - [difficulty]"
   - Ownership angle: "[ownership]% owned - [leverage insight]"
   - Recent form: "Averaging [X] pts over last 5 games"

3. Visual hierarchy: Keep captain name prominent, but make context easily scannable

**Why this matters:** Users need to understand if they're taking a differential punt vs playing it safe. Fixture context builds confidence in the pick.

</action>

<verify>
1. `npm run dev` - frontend compiles without errors
2. Navigate to /results/test - captain section shows fixture context and ownership insights
3. Check console logs - no errors from missing data fields
4. Test with different ownership percentages (mock data) - correct leverage insights display
</verify>

<done>
- Captain section displays fixture difficulty indicator
- Ownership leverage insight shows (differential vs template)
- Form trend badge appears when available
- Enhanced rationale includes fixture + ownership + form context
- All data gracefully degrades if fields missing
</done>
</task>

<task type="auto">
<name>Add timing and urgency insights to transfer recommendations</name>

<files>
frontend/src/components/TransferSection.tsx
backend/services/result_transformer.py
</files>

<action>
Surface timing urgency and decision confidence for transfers:

**Backend (result_transformer.py):**
1. In `_build_transfer_plans()`, add timing indicators:
   - Check if transfer involves injured/suspended player (URGENT priority)
   - Flag price change risk: "Player rising tonight" / "Player falling soon"
   - Add deadline pressure indicator: Days until GW deadline

2. Enhance confidence mapping in `_map_transfer_confidence()`:
   - Add context string: "High confidence: Injury replacement" / "Medium: Fixture upgrade" / "Low: Speculative punt"

3. Calculate opportunity cost: Compare 4GW delta to average expected transfer value (if < 8pts gain over 4GW, flag as marginal)

**Frontend (TransferSection.tsx):**
1. For primary transfer plan, add urgency indicators ABOVE the transfer arrow:
   - If URGENT priority: "⚠️ Injury/suspension - act before deadline"
   - If price change risk: "📈 Price rising tonight - transfer early"
   - If marginal value: "💰 Marginal gain - consider rolling transfer"

2. Add confidence badge below metrics row:
   - HIGH: Green badge "✓ High confidence"
   - MEDIUM: Yellow badge "⚡ Moderate confidence"
   - LOW: Orange badge "⚠️ Speculative"

3. For "ROLL TRANSFER" case, enhance reasoning:
   - Show what threshold wasn't met: "Best option gains only +2.3pts over 4GW (threshold: +8pts)"
   - Suggest future benefit: "Banking transfer gives 2FT flexibility next week"

**Why this matters:** Users need to know if they should act NOW vs wait. Confidence levels help them understand risk.

</action>

<verify>
1. Backend tests pass: `pytest backend/tests/test_result_transformer.py -v`
2. Frontend renders urgency indicators for URGENT priority transfers
3. Confidence badges display correctly for HIGH/MEDIUM/LOW
4. ROLL TRANSFER case shows threshold reasoning
5. Price change indicators appear when relevant data exists
</verify>

<done>
- Transfer urgency indicators show (injury, price change, deadline)
- Confidence badges display with contextual reasoning
- ROLL TRANSFER case explains threshold logic
- Opportunity cost surfaced for marginal transfers
- All timing insights gracefully degrade if data missing
</done>
</task>

<task type="auto">
<name>Add opportunity cost and timing window to chip recommendations</name>

<files>
frontend/src/components/ChipDecision.tsx
backend/services/result_transformer.py
frontend/src/pages/Results.tsx
</files>

<action>
Transform chip recommendations from "use/save" to "why this GW vs future GWs":

**Backend (result_transformer.py):**
1. In chip recommendation transformation (line 522-537), add:
   - Timing window: "Best GW for [chip] is GW[X] (+Y expected value)"
   - Opportunity cost: If recommending SAVE, explain what GW is better and why
   - Expected value comparison: This GW vs best future GW

2. Add new helper `_calculate_chip_opportunity()`:
   - Parse chip_guidance for timing data (best_gw field)
   - Calculate value difference: "Using now = X pts, waiting for GW[Y] = Z pts"
   - Return insight string

**Frontend (ChipDecision.tsx):**
1. After chip explanation, add "Timing Analysis" section (only if chip is SAVE):
   - Show best upcoming GW for each unused chip
   - Display expected value gain: "Bench Boost best in GW26 (DGW) - estimated +15pts vs +6pts this week"

2. For ACTIVE chip recommendations (use NOW):
   - Add urgency indicator: "🎯 Optimal window - use this GW"
   - Show why this GW is better: "Fixtures peak this week - future windows are weaker"

3. Visual: Add expandable "See future chip windows" accordion for users who want to plan ahead

**Frontend (Results.tsx):**
1. Pass available chip windows data from analysis to ChipDecision component
2. Add chip planning summary at bottom of results: "Future chip windows: BB (GW26 DGW), TC (GW29 vs MCI)"

**Why this matters:** Chip timing is THE most impactful decision in FPL. Users need to see opportunity cost to avoid FOMO.

</action>

<verify>
1. Backend transformation includes chip opportunity cost data
2. SAVE chip recommendations show "best future GW" reasoning
3. ACTIVE chip recommendations show "use now" urgency with context
4. Future chip windows accordion expands/collapses correctly
5. All chip insights degrade gracefully if timing data unavailable
</verify>

<done>
- Chip SAVE recommendations explain which GW is better and why
- Chip USE recommendations show urgency and value comparison
- Future chip windows displayed for planning
- Opportunity cost surfaced (this GW vs best future GW)
- Timing analysis section appears when relevant
</done>
</task>

## Verification

**Overall success criteria:**
1. Users can answer "WHY is this captain better?" from displayed context
2. Users can answer "SHOULD I act now or wait?" from transfer urgency
3. Users can answer "Is this the right GW for this chip?" from opportunity cost
4. All insights degrade gracefully when data fields are missing
5. No new errors in browser console
6. Visual hierarchy maintained (insights support decisions, don't overwhelm)

**Test with real analysis:**
1. Run full analysis for a test team
2. Navigate to results page
3. Verify all three sections (Captain, Transfers, Chips) show enhanced insights
4. Check that insights are ACTIONABLE (not just more text)

## Success Criteria

- Captain section includes fixture difficulty, ownership leverage, and form trends
- Transfer section shows urgency indicators, confidence levels, and timing context
- Chip section explains opportunity cost and optimal timing windows
- All insights use data already available in analysis output (no new backend computation)
- UI remains clean and scannable (insights enhance, don't clutter)
- Context ~30% usage (3 focused frontend + 1 backend enhancement tasks)

## Notes

**Design principle:** Insights should answer the question "So what?" for every recommendation.

**Data availability:** All context data already exists in the analysis output - we're just surfacing it better.

**Graceful degradation:** If any data field is missing (fixture difficulty, ownership, timing windows), the UI should still work, just without that specific insight.

**Visual hierarchy:** Insights should be secondary to the core recommendation. Use smaller text, muted colors, and clear sections.
