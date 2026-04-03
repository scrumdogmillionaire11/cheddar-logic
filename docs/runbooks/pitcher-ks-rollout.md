# Pitcher Ks Runbook

**WI chain:** WI-0595 → WI-0596 → WI-0597 → WI-0598 → WI-0599 → WI-0600 → WI-0727 → WI-0733 → WI-0738

**Current state (2026-04-02):** MLB pitcher strikeout cards are projection-only PASS rows. The prior odds-backed pull path has been removed to stop event-level Odds API burn. ADR-0009 selects a DK/FD-first scraping strategy with OddsTrader/OddsJam fallback, but that line contract is dormant and runtime publication remains `PROJECTION_ONLY` until a later implementation WI ships parser health, backoff, and source-policy guardrails.

---

## Overview

MLB pitcher strikeout (K) cards are still emitted by `job:run-mlb-model`, but they no longer ingest live `pitcher_strikeouts` lines from The Odds API.

| Mode | Trigger | Card characteristics | Budget impact |
|---|---|---|---|
| **Projection-only** | default and only supported mode | `basis: 'PROJECTION_ONLY'`, `prediction/status/action/classification: 'PASS'`, `tags` include `no_odds_mode`, `projection.probability_ladder` and `projection.fair_prices` populated, no live `line` / `line_source` | Zero event-level Odds API tokens |

## Future ODDS_BACKED Activation Gate

ADR-0009 defines the dormant standard + alt-line contract under `pitcher_k_line_contract`, but that object must not appear on `PROJECTION_ONLY` payloads yet.

Before any runtime odds-backed mode is enabled:
- Ship a dedicated scraper job for DraftKings/FanDuel first, with OddsTrader/OddsJam fallback only if direct-book parsing is unavailable or unhealthy
- Add source-specific rate limits, exponential backoff, parser-shape checks, and a freshness gate based on `MLB_K_PROP_FRESHNESS_MINUTES`
- Keep fail-closed behavior: if standard line, one side of juice, or alt ladder parsing is stale/malformed, publish `PROJECTION_ONLY` PASS instead of synthetic plays
- Re-check source terms and disable any source whose terms prohibit automated access or require authenticated scraping/CAPTCHA bypass

## Required Environment Flags

| Flag | Default | Purpose |
|---|---|---|
| `ENABLE_MLB_MODEL` | `true` | Master gate for MLB model jobs including pitcher K |
| `MLB_K_PROPS` | `SHADOW` | Governs MLB pitcher-K publication posture |
| `MLB_K_PROP_FRESHNESS_MINUTES` | `75` | Dormant pitcher-K line freshness window; line metadata older than this must not become executable |
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
          json_extract(payload_data, '$.prediction') AS prediction,
          json_extract(payload_data, '$.status_cap') AS status_cap,
          json_extract(payload_data, '$.tags') AS tags,
          json_extract(payload_data, '$.line') AS line,
          json_extract(payload_data, '$.projection.probability_ladder.p_6_plus') AS p_6_plus
   FROM card_payloads WHERE card_type='mlb-pitcher-k'
   ORDER BY created_at DESC LIMIT 5;"
```

**Expected:**
- `card_type = mlb-pitcher-k`
- `basis = PROJECTION_ONLY`
- `prediction = PASS`
- `status_cap = PASS`
- `tags` includes `no_odds_mode`
- `line` is null
- `p_6_plus` is numeric

### Checkpoint 2 — Contract and test pass

```bash
npm --prefix web run test:api:games:market
npm --prefix web run test:ui:cards
npm --prefix apps/worker test -- src/jobs/__tests__/run_mlb_model.test.js
npm --prefix packages/data test -- src/__tests__/validators/card-payload.mlb-pitcher-k.test.js --runInBand
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
| Cards are PASS-only | Expected current behavior | Use `projection.k_mean`, `probability_ladder`, and `playability` metadata for research; live line comparison is intentionally disabled |
| Missing-input fallback too frequent | Missing pitcher stats / stale enrichment / thin opponent splits | Check `projection_source`, `missing_inputs`, and `reason_codes` in `mlb-pitcher-k` payloads plus `run_mlb_model` logs |
| Cards not visible in Props tab | `mlb-pitcher-k` routing regression | Confirm route.ts still classifies `mlb-pitcher-k` as a prop surface |

## Rollout Completion Gate

- [ ] Projection-only emit confirmed
- [ ] Automated tests pass
- [ ] Props tab renders pitcher K cards
- [ ] ADR-0009 source policy and dormant line contract reviewed
- [ ] Docs and env examples no longer mention active odds-backed pitcher-K mode as live runtime behavior
