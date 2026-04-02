# Pitcher Ks Runbook

**WI chain:** WI-0595 → WI-0596 → WI-0597 → WI-0598 → WI-0599 → WI-0600 → WI-0727

**Current state (2026-04-02):** MLB pitcher strikeout cards are projection-only. The prior odds-backed pull path has been removed to stop event-level Odds API burn.

---

## Overview

MLB pitcher strikeout (K) cards are still emitted by `job:run-mlb-model`, but they no longer ingest live `pitcher_strikeouts` lines from The Odds API.

| Mode | Trigger | Card characteristics | Budget impact |
|---|---|---|---|
| **Projection-only** | default and only supported mode | `basis: 'PROJECTION_ONLY'`, `tags` include `no_odds_mode`, no live `line` / `line_source` required | Zero event-level Odds API tokens |

## Required Environment Flags

| Flag | Default | Purpose |
|---|---|---|
| `ENABLE_MLB_MODEL` | `true` | Master gate for MLB model jobs including pitcher K |
| `MLB_K_PROPS` | `SHADOW` | Governs MLB pitcher-K publication posture |
| `CHEDDAR_DB_PATH` | required | Worker write path; web remains read-only |

## Manual Commands

### Projection-only run

```bash
set -a; source .env; set +a

node apps/worker/src/jobs/pull_mlb_pitcher_stats.js
node apps/worker/src/jobs/pull_mlb_weather.js
npm --prefix apps/worker run job:run-mlb-model
```

### Full refresh

```bash
set -a; source .env; set +a; npm --prefix apps/worker run job:refresh-game-lines
```

## Acceptance Evidence Checklist

### Checkpoint 1 — Projection-only emit

```bash
set -a; source .env; set +a; npm --prefix apps/worker run job:run-mlb-model

sqlite3 "$CHEDDAR_DB_PATH" \
  "SELECT card_type, json_extract(payload_data, '$.basis') AS basis,
          json_extract(payload_data, '$.tags') AS tags,
          json_extract(payload_data, '$.line') AS line
   FROM card_payloads WHERE card_type='mlb-pitcher-k'
   ORDER BY created_at DESC LIMIT 5;"
```

**Expected:**
- `card_type = mlb-pitcher-k`
- `basis = PROJECTION_ONLY`
- `tags` includes `no_odds_mode`
- `line` is null or projection-only metadata, never a live ingested market line

### Checkpoint 2 — Contract and test pass

```bash
npm --prefix web run test:api:games:market
npm --prefix web run test:ui:cards
npm --prefix apps/worker test -- src/jobs/__tests__/run_mlb_model.test.js
```

### Checkpoint 3 — Props tab visibility (manual)

1. Start web: `CHEDDAR_DB_PATH=/tmp/cheddar-logic/cheddar.db npm --prefix web run dev`
2. Open [localhost:3000](http://localhost:3000) → **Props** tab
3. Select **Strikeouts Focus** preset or filter stat group to **Strikeouts**
4. Confirm pitcher K cards render with projection-only labeling and no expectation of live Odds API pricing

## Failure Mode Triage

| Symptom | Likely cause | Remediation |
|---|---|---|
| No pitcher K cards in DB | `ENABLE_MLB_MODEL=false` or no games with pitcher data | Check env flag; ensure pitcher stats and weather were pulled before model run |
| Cards are blocked too aggressively | Missing pitcher stats / stale enrichment / projection guard fired | Check `run_mlb_model` logs for pitcher validation reason codes |
| Cards not visible in Props tab | `mlb-pitcher-k` routing regression | Confirm route.ts still classifies `mlb-pitcher-k` as a prop surface |

## Rollout Completion Gate

- [ ] Projection-only emit confirmed
- [ ] Automated tests pass
- [ ] Props tab renders pitcher K cards
- [ ] Docs and env examples no longer mention odds-backed pitcher-K mode
