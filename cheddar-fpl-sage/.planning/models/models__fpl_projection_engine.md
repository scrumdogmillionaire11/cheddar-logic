---

# FPL Projection Engine v1.0

**Scope:** Generate player-level FPL point projections for next 6 GWs, with volatility and aggregation.

---

## 1. Inputs

```text
ProjectionEngineInput {
  season: string
  gameweek: int
  player_rows: PlayerProjectionRow[]
  fixture_rows: FixtureRow[]
  team_rows: TeamRow[]
}

PlayerProjectionRow {
  player_id: string
  name: string
  team: string
  position: "GK" | "DEF" | "MID" | "FWD"
  minutes_model: MinutesModel
  xG_model: XGModel
  xA_model: XAModel
  xCS_model: XCSModel
  volatility: "LOW" | "MED" | "HIGH"
  injury_flag: boolean
  ban_flag: boolean
  custom_tags: string[]
}

FixtureRow, TeamRow: see other models.
```

---

## 2. Outputs

```text
ProjectionEngineOutput {
  projections: PlayerProjection[]
  volatility_index: VolatilityIndex
}

PlayerProjection {
  player_id: string
  name: string
  team: string
  position: string
  nextGW_pts: float
  next6_pts: float
  xMins_next: float
  volatility: "LOW" | "MED" | "HIGH"
  tags: string[]
}

VolatilityIndex {
  high_vol_count: int
  med_vol_count: int
  low_vol_count: int
  squad_volatility: "LOW" | "MED" | "HIGH"
}
```

---

## 3. Projection Logic

- For each player:
  - Use minutes_model, xG_model, xA_model, xCS_model to project nextGW_pts and next6_pts.
  - Adjust for injury_flag, ban_flag, and custom_tags.
  - Volatility is set by upstream model or inferred from recent minutes/returns variance.
- Use fixture_rows for context (e.g., fixture difficulty, DGWs, blanks).
- Use team_rows for team-level context (e.g., form, rotation risk).

---

## 4. Volatility Index

- Count players by volatility bucket (LOW, MED, HIGH).
- squad_volatility is set by the modal bucket, or "HIGH" if ≥ 4 players are HIGH volatility.

---

## 5. Behavior Guarantees

- All projections must be deterministic for the same input set.
- No player may have nextGW_pts or next6_pts < 0.
- Volatility must be set for every player.
- Tags must be passed through from upstream models.