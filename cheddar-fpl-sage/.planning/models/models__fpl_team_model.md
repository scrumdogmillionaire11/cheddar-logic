---

# FPL Team Model v1.0

**Scope:** Interpret current squad + projections into tiers, flags, and structural weaknesses.

---

## 1. Inputs

```text
TeamModelInput {
  team: FplTeamInput
  projections: FplProjectionSet       # at least current + next 3 GWs
}
```
From FplProjectionSet, only rows matching team.players.player_id are required.

---

## 2. Outputs

```text
TeamModelOutput {
  season: string
  gameweek: int
  player_profiles: PlayerRoleProfile[]
  squad_structure: SquadStructureMetrics
  weakness_index: WeaknessIndex
}
```

### 2.1 PlayerRoleProfile
```text
PlayerRoleProfile {
  player_id: string
  name: string
  team: string
  position: "GK" | "DEF" | "MID" | "FWD"
  tier: 1 | 2 | 3 | 4
  flags: string[]              # see section 3
  nextGW_pts: float
  next6_pts: float
  xMins_next: float
  volatility: "LOW" | "MED" | "HIGH"
}
```

### 2.2 SquadStructureMetrics
```text
SquadStructureMetrics {
  gk_quality: float           # 0–10
  def_quality: float
  mid_quality: float
  fwd_quality: float
  bench_quality: float
  template_overlap: float | null  # 0–1 if EO available
  risk_balance: "CONSERVATIVE" | "BALANCED" | "AGGRESSIVE"
}
```

### 2.3 WeaknessIndex
```text
WeaknessIndex {
  gk_weak: 0–5
  def_weak: 0–5
  mid_weak: 0–5
  fwd_weak: 0–5
  bench_weak: 0–5
  overall_weak: 0–5
}
```
Higher = worse.

---

## 3. Flags

Flags are descriptive and used by downstream workflows:

- `MINUTES_RISK` — xMins_next < 60 or volatility = HIGH
- `NAILED_90` — xMins_next ≥ 85 with LOW volatility
- `SET_PIECES` — set_piece_role = "MAJOR"
- `PEN_TAKER` — inferred or passed from projection source
- `FIXTURE_BOOST` — next3 fixture cluster ≤ 2.0 average difficulty (attack or defense)
- `FIXTURE_TRAP` — next3 fixture cluster ≥ 4.0 average difficulty
- `XGI_SPIKE` — recent npxG+xA significantly > season baseline (if source supports)
- `UNDERPERFORMING` — xGI ≫ actual returns
- `OVERPERFORMING` — returns ≫ xGI
- `GOAL_THREAT_ONLY` — xG high, xA low
- `ASSIST_ONLY` — xA high, xG low
- `INJURY_SHADOW` — just back from injury / reduced xMins expectation

Flags are set using whatever upstream data is available; missing inputs simply drop flags.

---

## 4. Tier Assignment Rules

Tiers reflect role in your squad, not global ranking.

Let:
- P1 = nextGW_pts
- P6 = next6_pts

Position-compared percentiles are within your 15-man squad by position group.

### 4.1 Baseline Tier Heuristics
For each position group (GK/DEF/MID/FWD):
- Compute percentiles of P6 across that group
- Apply:
  - **Tier 1 (Core):**
    - P6 ≥ 75th percentile within the position, and
    - xMins_next ≥ 70, and
    - no FIXTURE_TRAP flag
  - **Tier 2 (Solid):**
    - P6 between 40th–74th percentile, or
    - P6 ≥ 75th percentile but MINUTES_RISK present
  - **Tier 3 (Replace Soon):**
    - P6 between 20th–39th percentile, or
    - FIXTURE_TRAP + not a nailed captain-level player
  - **Tier 4 (Sell / Dead Spot):**
    - P6 < 20th percentile, or
    - status_flag in {OUT, BANNED} beyond this GW, or
    - MINUTES_RISK + poor fixtures

Downstream workflows are allowed to treat “multiple Tier 3/4” as structural weakness.

---

## 5. Squad Structure Metrics

### 5.1 Slot Quality
For each line:
- GK quality = average P6 of GKs scaled to 0–10 relative to a simple global baseline (e.g. default PL GK distribution) or an internal reference
- Same for DEF, MID, FWD
- Bench quality = average P6 of non-starting players
- Mapping to 0–10 is implementation detail; required behavior:
  - Higher P6 → higher quality, linear or near-linear
  - Tier 1-heavy groups must push quality ≥ 7
  - Tier 3/4-heavy groups must drag quality ≤ 4

### 5.2 Risk Balance
Use flags:
- Count players with volatility = "HIGH" or MINUTES_RISK
- If ≤ 2 such players → risk_balance = "CONSERVATIVE"
- 3–4 → "BALANCED"
- ≥ 5 → "AGGRESSIVE"

---

## 6. Weakness Index Computation

For each line:
- line_weak = 0–5

Suggested mapping:
- Start from line_quality (0–10):
  - line_weak = max(0, 5 - (line_quality / 2))
- Then adjust:
  - +1 if ≥ half the line are Tier 3/4
  - +1 if key slot (e.g. captain-go-to FWD/MID) is Tier 3/4
- Cap at 5
- overall_weak = rounded average of all line weaknesses, capped at 5

Downstream rule of thumb:
- overall_weak ≥ 3 → candidate for Wildcard or multiple-hit rebuild
- Any line *_weak ≥ 4 → prioritize that line in transfers

---

## 7. Behavior Guarantees

- The model must never produce fewer than 1 Tier 1 player per line unless the whole team is structurally bad; then Tier distribution can collapse
- It must not assign Tier 4 to a nailed, high-projection captain-level asset unless:
  - Extended injury, or
  - Fixtures and projections collapse for multiple GWs
- This model does no transfer suggestions. It only labels the state for downstream use.