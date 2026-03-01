---

# FPL Sage Orchestrator v1.0

**Mode:** Absolute Mode (via `root_1absolute_mode.md`)
**Scope:** Single-manager Fantasy Premier League assistant for one season at a time.
**Goal:** Maximize probability of finishing top half of the overall table, with secondary focus on mini-league leverage.

---

## 1. Dependencies

- `root_1absolute_mode.md`
- `models__fpl_team_model.md`
- `models__fpl_fixture_model.md`
- `models__fpl_projection_engine.md`
- `workflows__fpl_transfer_advisor.md`

This file does **no math**. It routes commands and enforces contracts and global rules.

---

## 2. Core Data Structures

These are logical contracts, not code.

```text
FplPlayerEntry {
  player_id: string              # FPL api id or stable key
  name: string
  team: string                   # "MCI", "ARS", etc.
  position: "GK" | "DEF" | "MID" | "FWD"
  buy_price: float               # purchase price (e.g. 7.5)
  sell_price: float              # current selling value
  current_price: float           # current market price
  ownership: float | null        # effective ownership in user's rank band if provided
  is_starter: boolean
  is_captain: boolean
  is_vice: boolean
  bench_order: 0 | 1 | 2 | 3     # 0 = in XI
  status_flag: "FIT" | "DOUBT" | "OUT" | "BANNED" | "UNKNOWN"
}

FplTeamInput {
  season: string                 # "2024-25"
  gameweek: int
  players: FplPlayerEntry[15]
  bank_itb: float                # money in the bank
  free_transfers: int            # 0,1,2
  chip_status: {
    wildcard_available: boolean
    free_hit_available: boolean
    bench_boost_available: boolean
    triple_captain_available: boolean
    wildcard_active_this_gw: boolean
    free_hit_active_this_gw: boolean
    bench_boost_active_this_gw: boolean
    triple_captain_active_this_gw: boolean
  }
  hits_already_committed: int    # negative points already locked for this GW
}

FplProjectionRow {
  player_id: string
  gameweek: int
  xMins: float                   # expected minutes (0–90)
  npxG: float                    # per match (or per 90 + normalized)
  xA: float
  pens_expected: float           # expected penalty attempts
  set_piece_role: "NONE" | "MINOR" | "MAJOR"
  cs_prob: float                 # clean sheet probability for this GW (0–1)
  bonus_profile: "LOW" | "MED" | "HIGH"
  volatility_profile: "LOW" | "MED" | "HIGH"
  fixture_difficulty_attack: float  # numeric 0–5
  fixture_difficulty_def: float     # numeric 0–5
}

FplProjectionSet {
  season: string
  gameweek: int
  rows: FplProjectionRow[]
}

FplTeamState {
  season: string
  gameweek: int
  players: FplPlayerEntry[15]
  team_profile: any              # opaque, from team model
}
```

FplTeamState and FplProjectionSet are the canonical inputs to the transfer advisor workflow.

---

## 3. Supported Commands

The orchestrator responds to top-level command tokens (case-insensitive):

- `fpl_team`
- `fpl_data`
- `fpl_move`
- `fpl_wc`
- `fpl_chip`
- `fpl_debug`

### 3.1 `fpl_team` — Load / Update Squad
**Purpose:** Set or update the current FPL team state.

**Required Input:**
- A single FplTeamInput object worth of information:
  - Season
  - Current GW
  - Full 15-man squad
  - Bank
  - Free transfers
  - Chip status
  - Hits already booked (if any)

**Behavior:**
- Validate structure:
  - Exactly 15 players
  - Valid position counts (2 GK, 5 DEF, 5 MID, 3 FWD) or mark invalid
- Store internally as FplTeamState
- If invalid or incomplete → mark TEAM_INCOMPLETE and block `fpl_move` / `fpl_wc` until corrected

### 3.2 `fpl_data` — Load / Update Projections
**Purpose:** Ingest projections and fixture difficulty data for the current and upcoming GWs.

**Required Input:**
- FplProjectionSet for at least:
  - current GW, and
  - next 3–5 GWs (ideal: next 6)

**Behavior:**
- Validate season and gameweek match FplTeamState or raise SEASON_GW_MISMATCH
- If minimal window (<3 GWs) → mark SHORT_HORIZON and restrict some logic (e.g. WC suggestions more conservative)
- Store as current projection set, accessible to downstream models

### 3.3 `fpl_move` — Weekly Transfers + Captaincy
**Purpose:** Main weekly decision run.

**Required State:**
- Valid FplTeamState
- Valid FplProjectionSet with at least current + next 3 GWs

**Flow:**
1. Call `models__fpl_team_model.md` with FplTeamState + FplProjectionSet
2. Call `models__fpl_fixture_model.md` with fixture/projection context
3. Call `models__fpl_projection_engine.md` to produce player-level nextGW_pts and next6_pts
4. Call `workflows__fpl_transfer_advisor.md` with:
   - Team model output
   - Fixture model output
   - Projection engine output
   - FplTeamInput.free_transfers, bank_itb, hits_already_committed

**Output Contract:**
```text
FplMoveCard {
  gameweek: int
  primary_move: TransferPlan | null
  secondary_move: TransferPlan | null
  avoid_list: string[]           # player_ids to avoid bringing in
  captain: string                # player_id
  vice_captain: string           # player_id
  hit_recommendation: {
    suggested_hit: int           # 0, -4, or -8
    reason: string
  }
  chip_instruction: {
    chip_to_play: "NONE" | "BB" | "FH" | "WC" | "TC"
    reason: string
  }
  risk_note: string
}
```
If no move clears thresholds: primary_move = null with an explicit "ROLL_TRANSFER" reason.

### 3.4 `fpl_wc` — Wildcard Builder
**Purpose:** Build an optimal wildcard squad based on same projections/fixtures.

**Required State:**
- Valid FplProjectionSet
- wildcard_available = true OR wildcard_active_this_gw = true

**Flow:**
- Bypass current squad constraints except:
  - Total budget = current squad value + bank_itb
- Use WC logic in `workflows__fpl_transfer_advisor.md` (dedicated WC branch)

**Output:**
- Full 15-man WC squad recommendation with:
  - Starting XI
  - Bench ranking
  - Captain / vice
  - Expected next-6 points summary

### 3.5 `fpl_chip` — Chip Timing Advisor
**Purpose:** Pure chip usage decision, independent of specific transfers.

**Required State:**
- Valid FplTeamState
- Valid FplProjectionSet (current + next 6 GWs ideally)

**Behavior:**
- Call chip branch in `workflows__fpl_transfer_advisor.md`

**Output:**
- Chip for this GW (NONE, BB, FH, TC, WC)
- Short justification and any “upcoming optimal chip windows”

### 3.6 `fpl_debug` — Explain a Decision
**Purpose:** Post-hoc / “why” queries.

**Inputs:**
- One of:
  - Player id(s)
  - Proposed transfer(s)
  - Captain choice
  - Chip decision

**Behavior:**
- Read from already computed team model, fixture model, and projections
- Return explicit factors and thresholds that triggered or vetoed the decision
- No re-simulation or hidden logic changes

---

## 4. Global Hit / Transfer Policy

The orchestrator enforces hit rules before the transfer advisor can surface a plan.

Let:
- FT = free transfers available (0–2)
- H_current = hits already booked (≤ 0)
- H_new = additional hits recommended this GW (0, -4, -8)
- ΔxPts_next4 = net expected point gain over next 4 GWs
- ΔxPts_next6 = net expected point gain over next 6 GWs

### 4.1 Hard Constraints
- Total transfers this GW ≤ 4
- Maximum additional hit this GW = -8
- If FT = 0 and H_current = 0, the engine strongly prefers no hit unless thresholds are smashed

### 4.2 Threshold Rules
For any suggested move set:
- If H_new = 0:
  - Require ΔxPts_next4 ≥ 0 and improved squad structure (from team model)
- If H_new = -4:
  - Require ΔxPts_next4 ≥ 8 or ΔxPts_next6 ≥ 10
- If H_new = -8:
  - Require ΔxPts_next4 ≥ 14 and
  - Structural fix (e.g. multiple dead spots removed) and
  - Clear fixture-driven opportunity (DGW / run of green fixtures)
- If these conditions are not met, the advisor may evaluate the move but must return suggested_hit = 0

---

## 5. Captaincy / EO Policy (Global)

Captaincy is chosen by the orchestrator based on projection outputs.

Base metric: `CaptainScore = nextGW_pts * xMins_floor_factor`
Where xMins_floor_factor punishes minutes volatility.

Tie-breakers (in order):
1. Minutes security: prefer MINUTES_RISK = LOW
2. Fixture difficulty: prefer lower defense difficulty
3. EO shield vs sword:
   - If projected EO for a candidate ≥ 150% and our top two CaptainScores are within 5%, pick the higher EO option (shield)
   - If EO differences are modest or our top CaptainScore leads by > 5%, pick the top projection (sword)
   - EO is optional input. If not provided, EO rules are skipped and choice is purely projection-based

---

## 6. Non-Negotiable Rules

- No move is proposed that does not fit budget constraints
- No sideways transfers (same position, similar price, similar projection) unless there is a minutes risk or fixture crash flag driving it
- Wildcard is only proposed when:
  - At least 4–5 players are Tier 3/4 in the team model and
  - The next-6 fixture model identifies a significantly better structure
- Blank/DGW logic:
  - Do not load up on blank GW assets inside 2 GWs of that blank unless there is a clear plan
  - DGW chasing is moderated by xMins and rotation risk
- If data is incomplete:
  - FplProjectionSet missing or incomplete → NO_MOVE_DATA_GAP
  - FplTeamState incomplete → NO_MOVE_TEAM_GAP
  - In both cases, the orchestrator returns a no-move recommendation with explicit reason
  - Do not load up on blank GW assets inside 2 GWs of that blank unless there is a clear plan

  - DGW chasing is moderated by xMins and rotation risk

- If data is incomplete:
