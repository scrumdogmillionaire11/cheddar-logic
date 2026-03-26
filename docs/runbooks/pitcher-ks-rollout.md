# Pitcher Ks Rollout Runbook

**WI chain:** WI-0595 → WI-0596 → WI-0597 → WI-0598 → WI-0599 → WI-0600

**Current state (2026-03-26):** Projection-only mode active. Odds-backed mode gated behind `PITCHER_K_ODDS_ENABLED=true`.

---

## Overview

MLB pitcher strikeout (K) over/under cards are emitted by `job:run-mlb-model`. Two runtime modes exist:

| Mode | Trigger | Card characteristics | Budget impact |
|---|---|---|---|
| **Projection-only** | default (`PITCHER_K_ODDS_ENABLED` unset or `false`) | `tags: ['no_odds_mode']`, `basis: 'projection_only'`, no `line`/`line_source` | Zero extra API tokens |
| **Odds-backed** | `PITCHER_K_ODDS_ENABLED=true` | `basis: 'ODDS_BACKED'`, real `line` + `line_source` from Odds API | ~2 tokens/request × events per day |

---

## Mode Switch Protocol

### Activating odds-backed mode

1. Stop the scheduler: `./scripts/manage-scheduler.sh stop`
2. Add to `.env` (or `.env.production`): `PITCHER_K_ODDS_ENABLED=true`
3. (Optional) confirm budget headroom — odds pulls run before each model window.
4. Restart scheduler: `./scripts/manage-scheduler.sh start`
5. Verify: check next scheduler tick log for `pull_mlb_pitcher_k_odds` job entry.
6. Spot-check output: `sqlite3 "$CHEDDAR_DB_PATH" "SELECT card_type, json_extract(payload_data, '$.basis') AS basis, json_extract(payload_data, '$.line') AS line FROM card_payloads WHERE card_type='mlb-pitcher-k' ORDER BY created_at DESC LIMIT 5;"`
   - Expected: `basis=ODDS_BACKED` with a non-null `line` value.

### Reverting to projection-only mode

1. Stop scheduler.
2. Remove or set `PITCHER_K_ODDS_ENABLED=false` in `.env`.
3. Restart scheduler.
4. Verify next model run produces cards with `tags` containing `no_odds_mode`.

---

## Required Environment Flags

| Flag | Default | Purpose |
|---|---|---|
| `ENABLE_MLB_MODEL` | `true` | Master gate for all MLB model jobs including pitcher K |
| `PITCHER_K_ODDS_ENABLED` | `false` / unset | Enables odds-backed mode; scheduler pulls Odds API lines |
| `CHEDDAR_DB_PATH` | required | Must be set; write path for worker, read-only for web |

---

## Manual Commands

### Projection-only run (no extra API calls)

```bash
# Ensure env loaded
set -a; source .env; set +a

# Pull pitcher stats (scheduler does this automatically)
node apps/worker/src/jobs/pull_mlb_pitcher_stats.js

# Run MLB model (emits pitcher K cards in projection-only mode)
npm --prefix apps/worker run job:run-mlb-model
```

### Odds-backed run

```bash
set -a; source .env; set +a

# Pull pitcher K odds from The Odds API (requires PITCHER_K_ODDS_ENABLED=true)
npm --prefix apps/worker run job:pull-mlb-pitcher-k-odds

# Pull pitcher stats
node apps/worker/src/jobs/pull_mlb_pitcher_stats.js

# Run model
npm --prefix apps/worker run job:run-mlb-model
```

### Full refresh (game lines + pitcher K props)

```bash
set -a; source .env; set +a; npm --prefix apps/worker run job:refresh-game-lines
```

---

## Acceptance Evidence Checklist

Before marking the pitcher K rollout complete, capture evidence for each checkpoint below.

### Checkpoint 1 — Projection-only emit

```bash
# Run model in projection-only mode (PITCHER_K_ODDS_ENABLED unset)
set -a; source .env; set +a; npm --prefix apps/worker run job:run-mlb-model

# Verify cards emitted
sqlite3 "$CHEDDAR_DB_PATH" \
  "SELECT card_type, json_extract(payload_data, '$.basis') AS basis,
          json_extract(payload_data, '$.tags') AS tags,
          json_extract(payload_data, '$.line') AS line
   FROM card_payloads WHERE card_type='mlb-pitcher-k'
   ORDER BY created_at DESC LIMIT 5;"
```

**Expected:**
- `card_type = mlb-pitcher-k`
- `basis = projection_only`
- `tags` includes `no_odds_mode`
- `line = null` (no market line in this mode)

### Checkpoint 2 — Odds-backed emit

```bash
# With PITCHER_K_ODDS_ENABLED=true in .env
set -a; source .env; set +a
npm --prefix apps/worker run job:pull-mlb-pitcher-k-odds
npm --prefix apps/worker run job:run-mlb-model

sqlite3 "$CHEDDAR_DB_PATH" \
  "SELECT card_type, json_extract(payload_data, '$.basis') AS basis,
          json_extract(payload_data, '$.line') AS line,
          json_extract(payload_data, '$.line_source') AS line_source,
          json_extract(payload_data, '$.canonical_market_key') AS market_key
   FROM card_payloads WHERE card_type='mlb-pitcher-k'
   ORDER BY created_at DESC LIMIT 5;"
```

**Expected:**
- `basis = ODDS_BACKED`
- `line` is a numeric value (e.g. `5.5`)
- `line_source` set (e.g. `draftkings`)
- `canonical_market_key = pitcher_strikeouts`

### Checkpoint 3 — Contract and test pass

```bash
npm --prefix web run test:api:games:market
npm --prefix web run test:ui:cards
npm --prefix apps/worker test -- src/jobs/__tests__/run_mlb_model.test.js
npm --prefix packages/data test
```

**Expected:** All exit 0.

### Checkpoint 4 — Props tab visibility (manual)

1. Start web: `CHEDDAR_DB_PATH=/tmp/cheddar-logic/cheddar.db npm --prefix web run dev`
2. Open [localhost:3000](http://localhost:3000) → **Props** tab
3. Select **Strikeouts Focus** preset or filter stat group to **Strikeouts**
4. Confirm pitcher K cards render with expected label, status, and market display

---

## Failure Mode Triage

| Symptom | Likely cause | Remediation |
|---|---|---|
| No pitcher K cards in DB | `ENABLE_MLB_MODEL=false` or no games with pitcher data | Check env flag; ensure pitcher stats were pulled before model run |
| Cards have `basis=projection_only` after setting `PITCHER_K_ODDS_ENABLED=true` | Odds pull didn't run or returned 0 results | Check `pull_mlb_pitcher_k_odds` logs; confirm Odds API key and quota |
| Cards not visible in Props tab | `mlb-pitcher-k` market_type not routing to PROP | Confirm route.ts has `mlb-pitcher-k` in `inferMarketFromCardType` and `playProducerCardTypes` (WI-0599) |
| Duplicate pitcher K cards | Dedup key mismatch | Check `seenMlbPitcherKPlayKeys` logic in route.ts; verify `player_id` or `player_name` is populated in card payload |
| Stat group filter not working | `mapPropTypeToGroup` not returning `'K'` for `Strikeouts` propType | Verify `cards-page-client.tsx` returns `'K'` for `STRIKEOUT` normalized input |
| Validator errors in logs | Payload missing required fields | Check `mlbPitcherKPayloadSchema` in `card-payload.js`; add missing fields or correct model output |

---

## Rollout Completion Gate

- [ ] Projection-only emit confirmed (Checkpoint 1 evidence captured)
- [ ] Odds-backed emit confirmed when `PITCHER_K_ODDS_ENABLED=true` (Checkpoint 2 evidence captured, OR deferred until budget replenishes)
- [ ] All automated tests pass (Checkpoint 3 exit codes = 0)
- [ ] Props tab renders pitcher K cards (Checkpoint 4 manual confirmation)
- [ ] `docs/QUICKSTART.md` includes pitcher K commands and mode note
- [ ] `WORK_QUEUE/README.md` marks WI-0595–WI-0600 sequence complete
