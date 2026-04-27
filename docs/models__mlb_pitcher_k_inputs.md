# MLB Pitcher K Model Inputs

Authoritative reference for fields consumed by the pitcher-K projection path
(`calculateProjectionK` in `apps/worker/src/models/mlb-model.js`).

---

## Active input fields (K path)

| Field | Source | Required | Notes |
|---|---|---|---|
| `strikeouts` | `mlb_pitcher_game_logs` | Yes | Per-start K count; drives rolling K% windows |
| `walks` | `mlb_pitcher_game_logs` | Yes | Used in `recent_bb_pct` derivation (WI-1173) |
| `batters_faced` | `mlb_pitcher_game_logs` | Yes | Denominator for `recent_bb_pct`; gates SMALL_SAMPLE |
| `home_away` | `mlb_pitcher_game_logs` | Yes | Used to classify `home_away_context` (WI-1173) |
| `number_of_pitches` | `mlb_pitcher_game_logs` | Yes | Required for `last_three_pitch_counts` leash classification |
| `innings_pitched` | `mlb_pitcher_game_logs` | Yes | Used in `recent_k_per_9` and IP-proxy leash tier |
| `season_k_pct` | `mlb_pitcher_stats` | Yes | Season K rate — primary K projection input |
| `handedness` | `mlb_pitcher_stats` | Yes | Used for opponent split lookup |
| `season_starts` | `mlb_pitcher_stats` | Yes | Gates minimum-starts check |
| `days_since_last_start` | `mlb_pitcher_stats` | Yes | Required for rest/leash gate |
| `last_three_pitch_counts` | `mlb_pitcher_stats` | Yes | Drives leash tier classification |

---

## Command-context contract (WI-1173)

Derived from `strikeout_history` (last N=10 starts, sourced from `mlb_pitcher_game_logs`).
Implemented in `calculateProjectionK`.

### Derivation

```
recent_bb_pct = sum(walks) / sum(batters_faced)    [over last 10 starts]
```

### Status values

| Value | Condition |
|---|---|
| `MISSING` | No starts with `batters_faced > 0` in lookback |
| `SMALL_SAMPLE` | `sum(batters_faced) < 120` |
| `OK` | `sum(batters_faced) >= 120` |

The `120 BF` threshold is calibratable. Rationale: ~5 starts × 24 BF/start gives a stable
estimate of true BB rate. Below this, individual-start variance is too high to act on.

### command_risk_flag

```
command_risk_flag = (recent_bb_pct_status === 'OK') AND (recent_bb_pct >= 0.095)
```

The `0.095` threshold is **provisional and calibratable**. It should not be hard-coded at
call sites; use the `COMMAND_RISK_BB_PCT_THRESHOLD` constant in `mlb-model.js`.

### home_away_context values

| Value | Condition |
|---|---|
| `HOME` | `game_role === 'home'` (attributable) |
| `AWAY` | `game_role === 'away'` (attributable) |
| `MIXED` | `game_role` unknown AND lookback contains both H and A tags |
| `UNKNOWN` | `game_role` unknown AND insufficient split tags in lookback |

Home/away context is **confidence-only** — it does not modify the K projection value.
When `HOME` or `AWAY`, the reason code `HOME_AWAY_CONTEXT_SHIFT` is emitted.

### Projection adjustment

| Condition | Projection delta |
|---|---|
| `command_risk_flag = true` | `-0.15 Ks` |
| `SMALL_SAMPLE` | No projection change |
| `MISSING` | No projection change |

**Overlap cap**: `final_projection >= projection_pre_overlap - 0.30 Ks`.
The cap bounds the combined effect of WI-1173 command-context and future leash/fatigue
additive controls in the same overlap group. The `-0.15` penalty alone never hits the cap;
it is future-proofing for stacked risk controls.

### Confidence adjustments

| Condition | Confidence delta |
|---|---|
| `command_risk_flag = true` | `-5` |
| `SMALL_SAMPLE` | `-2` |
| `MISSING` | `0` (reason code only) |
| `HOME_AWAY_CONTEXT_SHIFT` | `0` (reason code only) |

### Reason codes

| Code | Meaning |
|---|---|
| `COMMAND_RISK_RECENT_BB_RATE` | Command risk fired (BB% >= threshold with OK sample) |
| `COMMAND_CONTEXT_SMALL_SAMPLE` | BB% computable but sample too small to trust |
| `COMMAND_CONTEXT_MISSING` | No batters_faced data in lookback |
| `HOME_AWAY_CONTEXT_SHIFT` | HOME or AWAY context is attributable (confidence-only) |

---

## Dead fields (removed from write path, WI-1173)

These columns exist in the `mlb_pitcher_game_logs` schema for historical rows but are
**no longer written** by `pull_mlb_pitcher_stats.js` as of WI-1173.

| Field | Status | Rationale |
|---|---|---|
| `hits` | Removed from write path | H/9 carries negligible K rate signal value |
| `earned_runs` | Removed from write path | ERA proxy carries negligible K rate signal value |

Schema columns are retained to avoid breaking existing historical rows. A schema-drop
migration can be filed as a separate serialized DB WI if desired.

---

## Deprecated fields (WI-0763 traceability)

The deprecated WI-0763 traceability fields (`bb_pct_from_logs`, `bb_pct_adjustment`,
`home_away_adj`) were removed in WI-1173 after confirming they had no remaining
in-repo runtime consumers.

---

## Active consumers of `strikeout_history` fields

The `buildPitcherStrikeoutLookback` query in `run_mlb_model.js` fetches:
`strikeouts`, `number_of_pitches`, `innings_pitched`, `walks`, `batters_faced`, `home_away`

These are the only fields consumed at runtime. `hits` and `earned_runs` are
intentionally excluded from that query.
