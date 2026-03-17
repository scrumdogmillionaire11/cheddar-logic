# MLB Pitcher Strikeout Props — Implementation Contract

_Frozen spec. All decisions are made. No placeholders remain. This doc is the implementation contract for WI-0390, WI-0391, WI-0392._

---

## Objective

v1 scope: cards-first, no settlement. The MLB pitcher strikeout prop model produces `market_type=PROP` cards surfaced in the betting dashboard. Settlement is explicitly out of scope for v1. No CLV ledger writes, no `settle_pending_cards` integration.

Goal: Given a scheduled MLB game with a confirmed starting pitcher, produce a PLAY card or PASS decision for the pitcher's strikeout over/under line. Card is written to `card_payloads` with `sport=MLB`, `card_type=mlb-pitcher-ks`.

---

## Data Sources

All 6 sources below are required for v1. Each entry specifies: source name, fields consumed, and where they come from.

1. **Odds API** (`https://the-odds-api.com`) — endpoint `/sports/baseball_mlb/odds?markets=pitcher_strikeouts` — fields: `bookmakers[].markets[].outcomes[].point` (the line), `bookmakers[].markets[].outcomes[].price` (American odds). Minimum 2 distinct bookmakers required.

2. **Baseball Savant / Statcast** (via `pybaseball` or CSV export) — fields: `csw_pct` (CSW%), `whiff_pct` (whiff rate), `k_pct` (K%), `avg_pitch_count` (last 5 starts), `pitches_per_inning` (last 5 starts). Used for pitcher execution profile.

3. **Fangraphs** (CSV export or scrape) — fields: pitcher `k_pct_season`, `swstr_pct`, batter lineup `k_pct_vs_hand` (K% vs pitcher handedness). Used for baseline K rate.

4. **Rotowire Lineups API** or **SportsDataIO `/StartingLineups`** — fields: `starting_pitcher_id`, `confirmed_lineup` (boolean), `lineup_order[1..9].batter_id`, `lineup_order[1..9].k_pct`. Required: lineup confirmed before card write.

5. **UmpScorecards** dataset — fields: `umpire_id`, `called_strike_boost` (numeric, +/- pct vs league avg). Source: `umpscorecards.com` dataset or scraped CSV.

6. **Baseball Savant park factors** (`https://baseballsavant.mlb.com/leaderboard/statcast-park-factors`) — fields: `park_k_factor` (numeric multiplier, 1.0 = neutral). Used as environment adjustment.

No other sources are required for v1. BvP, catcher framing, and bullpen fatigue are deferred.

---

## Model Math

**Consensus line derivation:**
```
consensus_line = median(bookmakers[].outcomes[where name=pitcher_name].point)
```
- Require at least 2 book lines to compute consensus. If fewer than 2, ABSTAIN.
- If max(lines) - min(lines) > 1.5, flag as CONFLICTING and ABSTAIN.

**Implied probability from American odds:**
```
if price >= 100:
  implied_prob = 100 / (price + 100)
else:
  implied_prob = abs(price) / (abs(price) + 100)

consensus_implied_prob = mean(implied_prob for each book's over price)
```

**Projected K probability:**
```
expected_batters_faced = (avg_pitch_count / pitches_per_inning) * 3

lineup_k_adjustment = mean(batter_k_pct_vs_hand for batters in confirmed_lineup[1..9])
                      / league_avg_k_pct_vs_hand   # ratio, 1.0 = neutral

ump_boost = called_strike_boost  # additive pct, e.g. +0.03

park_adj = park_k_factor         # multiplicative, e.g. 1.05

projected_ks = expected_batters_faced
               * pitcher_k_pct_season
               * lineup_k_adjustment
               * (1 + ump_boost)
               * park_adj
```

**Edge calculation:**
```
model_prob_over = P(actual_ks > consensus_line) derived from normal distribution:
  mu = projected_ks
  sigma = 1.8  # fixed for v1 (empirical MLB K distribution std)
  model_prob_over = 1 - normal_cdf(consensus_line + 0.5, mu, sigma)

edge = model_prob_over - consensus_implied_prob
```

**Decision:**
```
if edge >= MIN_EDGE:
  selection = OVER
  recommendation = PLAY
elif edge <= -MIN_EDGE:
  selection = UNDER
  recommendation = PLAY
else:
  recommendation = PASS
  pass_reason = "insufficient_edge"
```

MIN_EDGE = 0.04 (constant for v1, not configurable at runtime).

---

## Gates

All gates are evaluated before card write. Any gate failure results in ABSTAIN (no card written, log reason).

| Gate | Threshold | Failure Behavior |
|------|-----------|-----------------|
| min_books | >= 2 distinct books with K line | ABSTAIN: `missing_books` |
| lineup_confirmed | `confirmed_lineup == true` | ABSTAIN: `lineup_not_confirmed` |
| min_edge | abs(edge) >= 0.04 (4 percentage points) | PASS: `insufficient_edge` |
| price_cap_over | over_price >= -160 (no worse than -160) | ABSTAIN: `price_too_short_over` |
| price_cap_under | under_price >= -160 | ABSTAIN: `price_too_short_under` |
| line_conflict | max(lines) - min(lines) <= 1.5 | ABSTAIN: `conflicting_lines` |
| stale_data | odds captured_at within 4 hours of game start | ABSTAIN: `stale_odds` |
| pitcher_leash | avg_pitch_count >= 75 (last 5 starts) | ABSTAIN: `short_leash_pitcher` |

MIN_EDGE = 0.04 (constant for v1, not configurable at runtime).

---

## Payload Contract

Card written to `card_payloads` table with `card_type = 'mlb-pitcher-ks'`, `sport = 'MLB'`.

Required `payload_data` fields (JSON):

```json
{
  "market_type": "PROP",
  "prop_type": "pitcher_strikeouts",
  "pitcher_id": "<string: MLB player ID>",
  "pitcher_name": "<string>",
  "game_id": "<string: MLB game ID>",
  "home_team": "<string>",
  "away_team": "<string>",
  "generated_at": "<ISO 8601 UTC>",
  "selection": "OVER | UNDER | null",
  "line": "<number: consensus K line, e.g. 6.5>",
  "price": "<number: American odds integer, e.g. -115>",
  "recommendation": "PLAY | PASS | ABSTAIN",
  "pass_reason": "<string | null>",
  "edge": "<number: decimal, e.g. 0.06>",
  "model_prob": "<number: decimal 0-1>",
  "consensus_implied_prob": "<number: decimal 0-1>",
  "projected_ks": "<number: e.g. 7.2>",
  "expected_batters_faced": "<number: e.g. 21.3>",
  "books_used": ["<string book name>"],
  "missing_context_flags": ["<string>"],
  "inputs": {
    "pitcher_k_pct_season": "<number>",
    "lineup_k_adjustment": "<number>",
    "ump_boost": "<number>",
    "park_adj": "<number>",
    "avg_pitch_count": "<number>",
    "pitches_per_inning": "<number>"
  }
}
```

Fields `selection`, `line`, `price`, `edge`, `model_prob`, `consensus_implied_prob` may be `null` when `recommendation = ABSTAIN`.

No settlement fields. No `clv_ledger` writes. No `settle_pending_cards` integration.

---

## Failure Modes

| Failure | Condition | Card Written? | Reason Code |
|---------|-----------|---------------|-------------|
| Missing books | Fewer than 2 books return K line | No | `missing_books` |
| Missing prices | Book has line but no over/under price | No | `missing_prices` |
| Conflicting lines | max(lines) - min(lines) > 1.5 | No | `conflicting_lines` |
| Stale odds | `captured_at` > 4 hours before game start | No | `stale_odds` |
| Lineup not confirmed | `confirmed_lineup == false` at run time | No | `lineup_not_confirmed` |
| Short leash pitcher | `avg_pitch_count` < 75 over last 5 starts | No | `short_leash_pitcher` |
| Price too short | best available price worse than -160 | No | `price_too_short_over` or `price_too_short_under` |
| Insufficient edge | `abs(edge)` < 0.04 | Yes (PASS card) | `insufficient_edge` |
| Missing Statcast | CSW% / whiff% unavailable for pitcher | No | `missing_statcast` |

In all ABSTAIN cases: write a structured log entry (not a card). Do not throw. Continue processing remaining pitchers on the slate.

---

## Test Vectors

Each vector specifies inputs and the exact expected output fields. All use consistent units.

**Vector 1 — PASS: edge just misses threshold**
```
Inputs:
  pitcher_k_pct_season: 0.30
  avg_pitch_count: 95
  pitches_per_inning: 15
  lineup_k_adjustment: 1.10
  ump_boost: 0.03
  park_adj: 1.02
  consensus_line: 6.5
  over_price: -115
  books_used: ["DraftKings", "FanDuel", "BetMGM"]
  confirmed_lineup: true

Derived:
  expected_batters_faced = (95 / 15) * 3 = 19.0
  projected_ks = 19.0 * 0.30 * 1.10 * 1.03 * 1.02 = 6.57
  consensus_implied_prob = 115 / (115 + 100) = 0.535
  model_prob_over ~= 0.53  (normal_cdf(7.0, 6.57, 1.8) ~= 0.47 -> 1 - 0.47 = 0.53)
  edge = 0.53 - 0.535 = -0.005  -> insufficient edge

Expected output:
  recommendation: PASS
  pass_reason: insufficient_edge
```

**Vector 2 — PLAY OVER: clear model edge**
```
Inputs:
  pitcher_k_pct_season: 0.34
  avg_pitch_count: 98
  pitches_per_inning: 14
  lineup_k_adjustment: 1.15
  ump_boost: 0.05
  park_adj: 1.00
  consensus_line: 6.5
  over_price: -110
  books_used: ["DraftKings", "FanDuel"]
  confirmed_lineup: true

Derived:
  expected_batters_faced = (98 / 14) * 3 = 21.0
  projected_ks = 21.0 * 0.34 * 1.15 * 1.05 * 1.00 = 8.62
  consensus_implied_prob = 110 / (110 + 100) = 0.524
  model_prob_over ~= 0.82  (normal_cdf(7.0, 8.62, 1.8) ~= 0.18 -> 1 - 0.18 = 0.82)
  edge = 0.82 - 0.524 = 0.296  -> well above MIN_EDGE=0.04

Expected output:
  recommendation: PLAY
  selection: OVER
  line: 6.5
  price: -110
  edge: ~0.30 (rounded to 2 decimal places in practice)
```

**Vector 3 — ABSTAIN: only 1 book**
```
Inputs:
  books_available: 1
  confirmed_lineup: true
  consensus_line: 6.5

Expected output:
  recommendation: ABSTAIN
  pass_reason: missing_books
  selection: null
  line: null
  price: null
```

**Vector 4 — ABSTAIN: conflicting lines**
```
Inputs:
  book_lines: [6.5, 8.0]  (spread = 1.5, > threshold of 1.5)
  books_available: 2
  confirmed_lineup: true

Expected output:
  recommendation: ABSTAIN
  pass_reason: conflicting_lines
```

**Vector 5 — ABSTAIN: short leash pitcher**
```
Inputs:
  avg_pitch_count: 72  (< 75 threshold)
  confirmed_lineup: true
  books_available: 3
  consensus_line: 5.5

Expected output:
  recommendation: ABSTAIN
  pass_reason: short_leash_pitcher
```

**Vector 6 — ABSTAIN: price too short**
```
Inputs:
  pitcher_k_pct_season: 0.38
  consensus_line: 5.5
  over_price: -185  (worse than -160 cap)
  books_used: ["DraftKings", "FanDuel"]
  confirmed_lineup: true

Expected output:
  recommendation: ABSTAIN
  pass_reason: price_too_short_over
```

**Vector 7 — PLAY UNDER: negative edge play**
```
Inputs:
  pitcher_k_pct_season: 0.19
  avg_pitch_count: 88
  pitches_per_inning: 16
  lineup_k_adjustment: 0.82
  ump_boost: -0.02
  park_adj: 0.97
  consensus_line: 6.5
  under_price: -115
  books_used: ["DraftKings", "FanDuel", "BetMGM"]
  confirmed_lineup: true

Derived:
  expected_batters_faced = (88 / 16) * 3 = 16.5
  projected_ks = 16.5 * 0.19 * 0.82 * 0.98 * 0.97 = 2.45
  model_prob_over ~= 0.02  -> model_prob_under ~= 0.98
  consensus_implied_prob (under) = 115 / (115 + 100) = 0.535
  edge (under) = 0.98 - 0.535 = 0.445

Expected output:
  recommendation: PLAY
  selection: UNDER
  line: 6.5
  price: -115
  edge: ~0.44
```
