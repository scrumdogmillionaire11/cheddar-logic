
---

### `workflows__fpl_transfer_advisor.md` 

```md
# FPL Transfer Advisor Workflow v1.0

**Scope:** Convert team state + projections into weekly transfer, captaincy, and chip decisions.

---

## 1. Inputs

```text
TransferAdvisorInput {
  team_input: FplTeamInput
  team_model: TeamModelOutput
  fixture_profiles: FixtureProfile[]
  player_projections: PlayerProjection[]   # from projection engine
}
All structures are read-only; no in-place mutation.
```
## 2. Outputs
FplMoveCard {
  gameweek: int
  primary_move: TransferPlan | null
  secondary_move: TransferPlan | null
  avoid_list: string[]         # player_ids
  captain: string              # player_id
  vice_captain: string
  hit_recommendation: {
    suggested_hit: int         # 0, -4, or -8
    reason: string
  }
  chip_instruction: {
    chip_to_play: "NONE" | "BB" | "FH" | "WC" | "TC"
    reason: string
  }
  risk_note: string
}


TransferPlan:

TransferPlan {
  transfers: SingleTransfer[]
  total_hit: int               # 0, -4, or -8
  delta_next4_pts: float
  delta_next6_pts: float
  structural_improvement_tags: string[]  # e.g. ["FIXED_FORWARD_LINE", "ADDED_DGW_COVER"]
}

SingleTransfer {
  out_player_id: string
  in_player_id: string
  position: "GK" | "DEF" | "MID" | "FWD"
  net_cost: float              # transfer cost in money
}

## 3. High-Level Flow

Build current squad projections:

Sum next4 and next6 points for current team.

Generate candidate transfer sets:

0 transfers (roll).

1 transfer (use FT or -4 if FT=0).

2 transfers (FT=2 or FT+hit).

3–4 transfers only considered for Wildcard-like or major rebuild; require bigger thresholds.

Score each candidate set:

Compute Δnext4_pts and Δnext6_pts.

Evaluate structural tags.

Enforce hit policy (from orchestrator rules).

Choose:

primary_move as top viable plan.

secondary_move as backup (usually 0-hit or reduced-hit version).

Choose captain and vice.

Evaluate chip usage.

Emit FplMoveCard.

## 4. Move Generation Rules
4.1 Budget Constraints

Any candidate move set must satisfy:

Sum of incoming players’ current_price ≤

team total value (current squad value) + bank_itb + sum of sell_price for outgoing players.

Respect position template (2 GK, 5 DEF, 5 MID, 3 FWD).

If not satisfied, the move set is discarded.

4.2 Player Pools

Define:

SellPool:

All Tier 3/4 players from team_model.player_profiles.

BuyPool:

High next6_pts players (top tier globally by position) not already in squad.

Exclude:

Players flagged MINUTES_RISK + FIXTURE_TRAP.

Players with poor fixture profiles (attack/defence cluster rating < 2 unless punt).

For v1, combinatorics can be limited to:

At most:

5–10 candidates per position in BuyPool.

3–5 in SellPool.

## 5. Scoring a Transfer Plan

For each plan:

Re-compute team projection with new players.

Compute:

Δnext4_pts = new_team_next4_pts - old_team_next4_pts
Δnext6_pts = new_team_next6_pts - old_team_next6_pts


Evaluate structure:

structural_improvement_tags examples:

"UPGRADED_FORWARD_LINE": replaced low next6_pts FWDs with higher.

"FIXTURE_ALIGNMENT": more players with good fixture cluster ratings.

"DGV_COVER_ADDED": added DGW players with safe minutes.

"BLANK_RISK_REDUCED": fewer players with upcoming blanks.

Evaluate risk:

Count new players with volatility_flag = "HIGH" or MINUTES_RISK.

Penalize plans stacking volatility unless upside is substantial.

Score summarised as:

PlanScore = w4 * Δnext4_pts + w6 * Δnext6_pts + structure_bonus - volatility_penalty


Weights default:

w4 = 1.0 (short horizon)

w6 = 0.5 (medium horizon)

## 6. Hit Logic (Applied Here)

Given orchestrator thresholds:

If plan uses no hit (total_hit = 0):

Require Δnext4_pts ≥ 0 and at least one structural improvement tag.

If total_hit = -4:

Require Δnext4_pts ≥ 8 or Δnext6_pts ≥ 10.

If total_hit = -8:

Require Δnext4_pts ≥ 14 and at least 2 structural improvement tags.

If these are not met, downgrade plan to “invalid” for primary_move and secondary_move.

## 7. Avoid List

avoid_list is a simple array of player_ids that the engine actively does not want you to buy this GW.

A player goes on avoid_list if:
# FPL Transfer Advisor Workflow v1.0

**Scope:** Convert team state + projections into weekly transfer, captaincy, and chip decisions.

---

## 1. Inputs

```text
TransferAdvisorInput {
  team_input: FplTeamInput
  team_model: TeamModelOutput
  fixture_profiles: FixtureProfile[]
  player_projections: PlayerProjection[]   # from projection engine
}
```
All structures are read-only; no in-place mutation.

---

## 2. Outputs

```text
FplMoveCard {
  gameweek: int
  primary_move: TransferPlan | null
  secondary_move: TransferPlan | null
  avoid_list: string[]         # player_ids
  captain: string              # player_id
  vice_captain: string
  hit_recommendation: {
    suggested_hit: int         # 0, -4, or -8
    reason: string
  }
  chip_instruction: {
    chip_to_play: "NONE" | "BB" | "FH" | "WC" | "TC"
    reason: string
  }
  risk_note: string
}

TransferPlan {
  transfers: SingleTransfer[]
  total_hit: int               # 0, -4, or -8
  delta_next4_pts: float
  delta_next6_pts: float
  structural_improvement_tags: string[]  # e.g. ["FIXED_FORWARD_LINE", "ADDED_DGW_COVER"]
}

SingleTransfer {
  out_player_id: string
  in_player_id: string
  position: "GK" | "DEF" | "MID" | "FWD"
  net_cost: float              # transfer cost in money
}
```

---

## 3. High-Level Flow

- Build current squad projections: sum next4 and next6 points for current team
- Generate candidate transfer sets:
  - 0 transfers (roll)
  - 1 transfer (use FT or -4 if FT=0)
  - 2 transfers (FT=2 or FT+hit)
  - 3–4 transfers only considered for Wildcard-like or major rebuild; require bigger thresholds
- Score each candidate set:
  - Compute Δnext4_pts and Δnext6_pts
  - Evaluate structural tags
  - Enforce hit policy (from orchestrator rules)
- Choose:
  - primary_move as top viable plan
  - secondary_move as backup (usually 0-hit or reduced-hit version)
  - Choose captain and vice
  - Evaluate chip usage
  - Emit FplMoveCard

---

## 4. Move Generation Rules

### 4.1 Budget Constraints

Any candidate move set must satisfy:
- Sum of incoming players’ current_price ≤ team total value (current squad value) + bank_itb + sum of sell_price for outgoing players
- Respect position template (2 GK, 5 DEF, 5 MID, 3 FWD)
- If not satisfied, the move set is discarded

### 4.2 Player Pools

Define:
- SellPool: All Tier 3/4 players from team_model.player_profiles
- BuyPool: High next6_pts players (top tier globally by position) not already in squad
- Exclude:
  - Players flagged MINUTES_RISK + FIXTURE_TRAP
  - Players with poor fixture profiles (attack/defence cluster rating < 2 unless punt)
For v1, combinatorics can be limited to:
- At most: 5–10 candidates per position in BuyPool, 3–5 in SellPool

---

## 5. Scoring a Transfer Plan

For each plan:
- Re-compute team projection with new players
- Compute:
  - Δnext4_pts = new_team_next4_pts - old_team_next4_pts
  - Δnext6_pts = new_team_next6_pts - old_team_next6_pts
- Evaluate structure:
  - structural_improvement_tags examples:
    - "UPGRADED_FORWARD_LINE": replaced low next6_pts FWDs with higher
    - "FIXTURE_ALIGNMENT": more players with good fixture cluster ratings
    - "DGV_COVER_ADDED": added DGW players with safe minutes
    - "BLANK_RISK_REDUCED": fewer players with upcoming blanks
- Evaluate risk:
  - Count new players with volatility_flag = "HIGH" or MINUTES_RISK
  - Penalize plans stacking volatility unless upside is substantial
- Score summarised as:
  - PlanScore = w4 * Δnext4_pts + w6 * Δnext6_pts + structure_bonus - volatility_penalty
  - Weights default: w4 = 1.0 (short horizon), w6 = 0.5 (medium horizon)

---

## 6. Hit Logic (Applied Here)

Given orchestrator thresholds:
- If plan uses no hit (total_hit = 0):
  - Require Δnext4_pts ≥ 0 and at least one structural improvement tag
- If total_hit = -4:
  - Require Δnext4_pts ≥ 8 or Δnext6_pts ≥ 10
- If total_hit = -8:
  - Require Δnext4_pts ≥ 14 and at least 2 structural improvement tags
- If these are not met, downgrade plan to “invalid” for primary_move and secondary_move

---

## 7. Avoid List

avoid_list is a simple array of player_ids that the engine actively does not want you to buy this GW.
A player goes on avoid_list if:
- They are in BuyPool by raw points but:
  - MINUTES_RISK + high price, or
  - FIXTURE_TRAP with next3 attack/defence difficulty ≥ 4, or
  - clear OVERPERFORMING flag (goals >> xG) with fixture downturn
The advisor must never recommend a player on avoid_list in primary_move or secondary_move

---

## 8. Captaincy Selection

Input: player_projections + team_model
Steps:
- Consider only players in XI (or likely XI)
- Compute a CaptainScore per candidate:
  - CaptainScore = nextGW_pts * minutes_floor_factor * fixture_factor
  - Heuristics:
    - minutes_floor_factor: 1.0 for secure, 0.8 for mild risk, 0.6 for high risk
    - fixture_factor: 1.1 for attack_difficulty ≤ 2, 1.0 for 3, 0.9 for ≥4
- Pick top 2–3 by score
- Apply EO rule (if EO available as ownership):
  - If top two CaptainScore values differ by < 5%, and one has EO ≥ 150%: Choose that player (shield)
  - Otherwise: Choose highest score (sword)
- Vice-captain = second-best CaptainScore with strong minutes security

---

## 9. Chip Logic

Chip suggestion is conservative.

### 9.1 Bench Boost
Recommend BB this GW only if:
- bench_quality ≥ 6 from squad_structure
- All 15 players have xMins_next ≥ 60 for current GW
- No status OUT, BANNED, or strong MINUTES_RISK
- Combined bench nextGW_pts ≥ threshold (e.g. 16+ expected points)
Otherwise BB stays "NONE"

### 9.2 Free Hit
Recommend FH only when:
- Upcoming GW (current or within 1 GW) has blank_count affecting ≥ 4–5 of your core starters
- FH is available and not more valuable later (heuristic comparison with later known blanks)
If conditions are not strong, return "NONE" with a note like “Hold FH, structure manageable”

### 9.3 Wildcard
Recommend WC only when all:
- weakness_index.overall_weak ≥ 3
- At least 4–5 players are Tier 3/4
- Fixture profiles show a clear path to a significantly higher next6_pts with a new squad
If you already activated WC, the WC branch builds the squad rather than suggesting whether to play it

### 9.4 Triple Captain
Recommend TC only when:
- A captain candidate has:
  - nextGW_pts materially ahead of other options (e.g. ≥ 3 pts higher than second-best)
  - Very high xMins_next and low volatility
  - Either DGW with both legs favorable, or an elite single fixture
Otherwise TC remains on hold

---

## 10. Risk Note

The final risk_note is a short summary of:
- Main risk to the primary_move: e.g. “High reliance on rotation-prone asset”, or “Hit justified by DGW upside; variance high”
- If no move: Reason: data gap, fixture uncertainty, or threshold not met
The note is descriptive only, no hand-holding

---

## 11. Behavior Guarantees

- The advisor can legally output: primary_move = null and “ROLL_TRANSFER” with explanation
- It must never:
  - Propose moves that do not fit the budget
  - Use a player on avoid_list
  - Suggest a hit that fails the defined thresholds
- When multiple plans pass thresholds:
  - Choose the one with highest PlanScore
  - Use lower hit as tie-breaker