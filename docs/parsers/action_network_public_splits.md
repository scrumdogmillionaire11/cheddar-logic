# ActionNetwork Public Splits — Parser Spec

**Adapter:** `packages/adapters/src/action-network.js` (v2)
**Status:** SCHEMA_HYPOTHESIS — synthetic seed fixtures in place; replace with real browser captures per `packages/adapters/fixtures/action_network/CAPTURE_INSTRUCTIONS.md`
**WI:** WI-0759 (fixture capture + parser spec)
**Last confirmed:** _pending real browser capture_

---

## Endpoint

```
GET https://api.actionnetwork.com/web/v1/{sport_lowercase}?bookIds=BOOK_IDS&date={YYYYMMDD}&periods=event
```

**Access constraint:** Blocked from server/datacenter IPs via CloudFront.
Accessible only from authenticated browser sessions. Tested HTTP responses from
curl (even with browser User-Agent) return `{"statusCode":404,"error":"Not Found","message":"No Content found"}`.

---

## Top-Level Response Shape (Hypothesized)

```json
{
  "games": [
    {
      "id": 119801,
      "start_time": "2026-04-03T23:00:00Z",
      "home_team": { "id": 2, "full_name": "Boston Celtics", "abbr": "BOS" },
      "away_team": { "id": 15, "full_name": "New York Knicks", "abbr": "NYK" },
      "bets": [ ... ]
    }
  ]
}
```

The adapter also checks `body.data` and `body` (array root) as fallbacks for
the games array (`fetchSplitsForDate` L: `body.games || body.data || ...`).

---

## Game Object Fields

| Field           | Type              | Notes |
|-----------------|-------------------|-------|
| `id`            | number            | ActionNetwork internal game ID. Adapter also checks `game_id`, `gameId`. |
| `start_time`    | ISO 8601 string   | UTC. Adapter also checks `startTime`, `commence_time`, `game_time`, `gameTime`. |
| `home_team`     | object            | Has `full_name` (adapter also checks `name`, `fullName`). Also checks flat `home_team_name`. |
| `away_team`     | object            | Same as `home_team`. |
| `bets`          | array             | Per-market split entries. See below. |

---

## Bets Array — Per-Market Entry Fields

### `bet_type` Key Strings

The adapter accepts these `bet_type` values (MARKET_KEY_MAP):

| `bet_type` value (API)  | Mapped to | Notes |
|-------------------------|-----------|-------|
| `money_line`            | `ML`      | Primary observed key (hypothesis) |
| `moneyline`             | `ML`      | Alias (hypothesis) |
| `spread`                | `SPREAD`  | Primary observed key (hypothesis) |
| `point_spread`          | `SPREAD`  | Alias (hypothesis) |
| `total`                 | `TOTAL`   | Primary observed key (hypothesis) |
| `game_total`            | `TOTAL`   | Alias (hypothesis) |

**⚠ UNCONFIRMED:** All `bet_type` values above are hypothesis-only. Real browser
captures required to confirm or correct. Update MARKET_KEY_MAP after confirmation.

---

### ML / SPREAD Entry Fields (`selectionScope: HOME_AWAY`)

| Field                                         | Type         | Required? | Notes |
|-----------------------------------------------|--------------|-----------|-------|
| `bet_type`                                    | string       | yes       | `money_line` or `moneyline` or `spread` or `point_spread` |
| `home_bets` / `home_bets_pct` / `home_bets_%` | number (0–100) | no      | % of bets on home side. At least one alias must be present for `bets_pct` to be non-null. |
| `away_bets` / `away_bets_pct` / `away_bets_%` | number (0–100) | no      | % of bets on away side. Asymmetric (one null, one present) → INVALID_INPUT. |
| `home_handle` / `home_handle_pct` / `home_handle_%` | number (0–100) | no | % of handle on home side. |
| `away_handle` / `away_handle_pct` / `away_handle_%` | number (0–100) | no | Asymmetric → INVALID_INPUT. |
| `home_tickets` / `home_tickets_pct` / `home_tickets_%` | number (0–100) | no | % of tickets. Informational only; not validated with sum check. |
| `away_tickets` / `away_tickets_pct` / `away_tickets_%` | number (0–100) | no | |
| `spread` / `line` / `current_spread` / `current_line` | number | SPREAD only | Required for SPREAD (null → INVALID_INPUT). Not used for ML (output `line` is null). |

---

### TOTAL Entry Fields (`selectionScope: OVER_UNDER`)

| Field                                          | Type         | Required? | Notes |
|------------------------------------------------|--------------|-----------|-------|
| `bet_type`                                     | string       | yes       | `total` or `game_total` |
| `over_bets` / `over_bets_pct` / `over_bets_%`  | number (0–100) | no     | % of bets on over. |
| `under_bets` / `under_bets_pct` / `under_bets_%` | number (0–100) | no   | Asymmetric with `over_bets` → INVALID_INPUT. |
| `over_handle` / `over_handle_pct` / `over_handle_%` | number (0–100) | no | % of handle on over. |
| `under_handle` / `under_handle_pct` / `under_handle_%` | number (0–100) | no | |
| `over_tickets` / `over_tickets_pct` / `over_tickets_%` | number (0–100) | no | % of tickets. |
| `under_tickets` / `under_tickets_pct` / `under_tickets_%` | number (0–100) | no | |
| `total` / `line` / `current_total` / `current_line` | number | yes | Required for TOTAL (null → INVALID_INPUT). |

---

## Validation Rules

### Pct-Sum Tolerance

- Both null → valid (informational gap, not bad data)
- One null, one present → **INVALID_INPUT** (asymmetric, side-order ambiguous)
- Both present → sum must be in **[96, 104]**
  - Allows for whole-number rounding (±2 per side)
  - Allows for stale partial updates observed in community captures
  - Beyond 104 → suggests scale error or duplicate field read → **INVALID_INPUT**

If real captures consistently show sums outside [96, 104], update `PCT_SUM_MIN`
/ `PCT_SUM_MAX` in the adapter and record the fixture date that justified it.

### Line Requirement

- `SPREAD` market without a line → **INVALID_INPUT**
- `TOTAL` market without a line → **INVALID_INPUT**
- `ML` market → `line` is always `null` in output (not validated)

---

## Canonical Output Shape

Each game normalised by `normalizeSplitsResponse()`:

```json
{
  "actionNetworkGameId": "119801",
  "homeTeam": "Boston Celtics",
  "awayTeam": "New York Knicks",
  "commenceTime": "2026-04-03T23:00:00.000Z",
  "markets": [
    {
      "marketType": "ML",
      "selectionScope": "HOME_AWAY",
      "valid": true,
      "home_or_over_bets_pct": 62,
      "away_or_under_bets_pct": 38,
      "home_or_over_handle_pct": 55,
      "away_or_under_handle_pct": 45,
      "home_or_over_tickets_pct": 62,
      "away_or_under_tickets_pct": 38,
      "line": null,
      "source": "ACTION_NETWORK",
      "sourceMarketKey": "money_line"
    },
    {
      "marketType": "SPREAD",
      "selectionScope": "HOME_AWAY",
      "valid": true,
      "home_or_over_bets_pct": 58,
      "away_or_under_bets_pct": 42,
      "home_or_over_handle_pct": 52,
      "away_or_under_handle_pct": 48,
      "home_or_over_tickets_pct": 57,
      "away_or_under_tickets_pct": 43,
      "line": -5.5,
      "source": "ACTION_NETWORK",
      "sourceMarketKey": "spread"
    },
    {
      "marketType": "TOTAL",
      "selectionScope": "OVER_UNDER",
      "valid": true,
      "home_or_over_bets_pct": 64,
      "away_or_under_bets_pct": 36,
      "home_or_over_handle_pct": 60,
      "away_or_under_handle_pct": 40,
      "home_or_over_tickets_pct": 64,
      "away_or_under_tickets_pct": 36,
      "line": 224.5,
      "source": "ACTION_NETWORK",
      "sourceMarketKey": "total"
    }
  ]
}
```

### Invalid Market Shape

```json
{
  "marketType": "ML",
  "selectionScope": "HOME_AWAY",
  "valid": false,
  "invalidReason": "INVALID_INPUT: money_line.bets: sum 91.0 outside [96, 104]",
  "source": "ACTION_NETWORK",
  "sourceMarketKey": "money_line"
}
```

**Caller contract:** `markets[]` retains BOTH valid and invalid entries.
Callers must `markets.filter(m => m.valid)` before using data. This lets
callers distinguish "market absent" (not in array) from "market rejected"
(in array, `valid: false`).

---

## Discrepancies vs. Adapter v2 Hypothesis

_To be filled in after real browser captures are made._

| Field / Key       | Hypothesis          | Confirmed | Notes |
|-------------------|---------------------|-----------|-------|
| ML `bet_type`     | `money_line`       | ❓        | Also aliases `moneyline` |
| Spread `bet_type` | `spread`           | ❓        | Also aliases `point_spread` |
| Total `bet_type`  | `total`            | ❓        | Also aliases `game_total` |
| Bets field (home) | `home_bets`        | ❓        | |
| Bets field (away) | `away_bets`        | ❓        | |
| Handle field (home) | `home_handle`    | ❓        | |
| Handle field (away) | `away_handle`    | ❓        | |
| Over bets field   | `over_bets`        | ❓        | |
| Under bets field  | `under_bets`       | ❓        | |
| Over handle field | `over_handle`      | ❓        | |
| Under handle field | `under_handle`    | ❓        | |
| Spread line field | `spread`           | ❓        | Also checks `line`, `current_spread` |
| Total line field  | `total`            | ❓        | Also checks `line`, `current_total` |
| Tickets fields    | `home_tickets`, etc. | ❓      | Possibly absent in real responses |
| pct sum range     | [96, 104]          | ❓        | Update if real data shows wider range |

---

## References

- Adapter source: `packages/adapters/src/action-network.js`
- Synthetic seed fixtures: `packages/adapters/fixtures/action_network/*.synthetic-seed.raw.json`
- Capture instructions: `packages/adapters/fixtures/action_network/CAPTURE_INSTRUCTIONS.md`
- WI-0759 scope: confirms field names, updates MARKET_KEY_MAP, adds fixture-driven tests
