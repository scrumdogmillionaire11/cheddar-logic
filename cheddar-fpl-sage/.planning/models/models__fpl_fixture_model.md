---

# FPL Fixture Model v1.0

**Scope:** Evaluate fixture difficulty and opportunity for next 6 GWs.

---

## 1. Inputs

Fixture model does not parse raw calendars; it expects pre-normalized rows.

```text
FixtureRow {
  team: string                # "MCI", "ARS"
  opponent: string
  gameweek: int
  venue: "H" | "A"
  xG_for_team: float          # baseline expectation for team in that fixture
  xG_against_team: float      # baseline expectation against team in that fixture
  xG_for_opponent: float | null
  xG_against_opponent: float | null
  book_goals_for: float | null   # optional market-based expectation
  book_cs_prob: float | null     # optional
  competition: "PL" | "CUP" | "UCL" | "OTHER"
  is_dgw_leg: boolean
  is_blank: boolean
  context_tags: string[]      # "DERBY", "TITLE_RACE", ...
}

FixtureModelInput {
  season: string
  base_gameweek: int
  rows: FixtureRow[]          # ideally covering base GW to baseGW+5
}
```

---

## 2. Outputs

```text
FixtureProfile {
  team: string
  window_start_gw: int
  window_end_gw: int          # baseGW+5 if 6-week window
  attack_cluster_rating: float   # 0–5
  defense_cluster_rating: float  # 0–5
  avg_attack_difficulty: float   # lower is better
  avg_defense_difficulty: float
  dgw_count: int
  blank_count: int
  spike_fixtures: int           # count of clearly good fixtures
  trap_fixtures: int            # count of clearly bad fixtures
  per_fixture: FixtureProjection[]
}

FixtureProjection {
  gameweek: int
  opponent: string
  venue: "H" | "A"
  attack_difficulty: float      # 1–5, 1 = best
  defense_difficulty: float     # 1–5
  p_goals_for: float | null
  p_clean_sheet: float | null
  is_dgw_leg: boolean
  is_blank: boolean
  tags: string[]
}
```

Output is per team.

---

## 3. Per-Fixture Difficulty Scales

### 3.1 Attack Difficulty (for our attackers)

- Base on opponent defensive xG metrics and venue.
- Start from opponent xG_against_opponent (lower = better defense).
- Normalize into a 1–5 band:

**Example (conceptual thresholds, league-specific tuning allowed):**

- **1 (Excellent):**
  - Opponent xGA is bottom-quartile (i.e. they concede a lot).
  - Or book expects high goals for.
- **2 (Good):**
  - Slightly below-average defense.
- **3 (Neutral):**
  - Around league average.
- **4 (Tough):**
  - Above-average defense.
- **5 (Brutal):**
  - Elite defense + away.

**Venue tweak:**
- If venue = H → reduce difficulty by ~0.3, clamp [1,5].
- If venue = A → increase by ~0.3, clamp [1,5].

### 3.2 Defense Difficulty (for our defenders/GKs)

- Base on opponent xG_for_team and their attacking strength.
- **1 (Excellent CS chance):** Opponent bottom quartile for attack.
- **2 (Good):** Below average attack.
- **3 (Neutral):** Average.
- **4 (Tough):** Good attack.
- **5 (Brutal):** Elite attack.
- Same venue adjustment as above but inverted for defense if desired.

---

## 4. Window Aggregates

Use all rows where:
- team = X
- gameweek ∈ [base_gameweek, base_gameweek+5]
- competition = "PL" (ignore cups by default or mark separately).

### 4.1 Averages
- avg_attack_difficulty = mean(attack_difficulty where not blank)
- avg_defense_difficulty = mean(defense_difficulty where not blank)

### 4.2 Cluster Ratings (0–5)
- Convert averages to 0–5 ratings where higher = better for FPL.
- We invert difficulty:

```text
attack_cluster_rating = clamp(0, 5, 5 - (avg_attack_difficulty - 1) * attack_scale)
defense_cluster_rating = clamp(0, 5, 5 - (avg_defense_difficulty - 1) * defense_scale)
```

- Default attack_scale = defense_scale = 1.0.
- Heuristics:
  - attack_cluster_rating ≥ 4 → “elite short-term attacking run”.
  - attack_cluster_rating ≤ 2 → “bad attacking run (trap)”.
  - Same for defence.

### 4.3 DGWs and Blanks
- dgw_count = count of gameweeks where team has more than one non-blank PL fixture.
- blank_count = count of is_blank = true rows.

### 4.4 Spike / Trap Fixtures
- A spike fixture for attack: attack_difficulty ≤ 2.
- A trap fixture for attack: attack_difficulty ≥ 4.
- Similarly definable for defence.
- Count spike/trap fixtures for the profile.

---

## 5. Probabilities (optional)

- If bookmaker expectations (book_goals_for, book_cs_prob) are present, they override raw xG hints:
  - p_goals_for = book_goals_for if available, else derived from xG_for_team.
  - p_clean_sheet = book_cs_prob if available, else derived from defensive difficulty scale.
- Exact mapping is implementation detail; the projections engine will use these to bias FPL points.

---

## 6. Tags

- Tags enrich FixtureProjection.tags:
  - From context_tags: "DERBY", "TITLE_RACE", "RELEGATION_SIX_POINTER", "POST_EUROPE", "EARLY_KO", etc.
  - From difficulty:
    - "ATTACK_SPIKE" if attack_difficulty ≤ 2.
    - "ATTACK_TRAP" if attack_difficulty ≥ 4.
    - "DEF_SPIKE", "DEF_TRAP" analogously.
- Downstream use:
  - Attackers benefit from "ATTACK_SPIKE".
  - Defenders benefit from "DEF_SPIKE".
  - "DERBY" or "TITLE_RACE" may increase variance (used as volatility hints).

---

## 7. Behavior Guarantees

- All PL fixtures in the window must yield a FixtureProjection, even if some metrics are null.
- Blanks must appear explicitly with is_blank = true and no probabilities.
- The model must not silently drop DGW legs or cup matches; at minimum they must be tagged so downstream logic can decide to ignore or use them.