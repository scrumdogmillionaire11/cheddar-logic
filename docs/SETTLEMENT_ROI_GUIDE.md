# Settlement ROI Report — Operator Guide

## 1. Overview

`scripts/settlement-roi-report.js` produces a cross-market win-rate and ROI read from `card_results` settled since 2026-01-01. It is the first reliable cross-market ROI cut and gates all future model promotion and quarantine decisions.

**When to run:** On-demand, before any model promotion or quarantine decision. Safe to run at any time — all operations are read-only.

**What it produces:**
- A per-market breakdown table (sport, market_key, period, settled count, win/loss/push counts, win rate, avg CLV, cumulative units, recommendation)
- A per-sport rollup (sport, total settled, blended win rate, total units, top market by units)

---

## 2. How to Run

```bash
# On prod host (Pi) — full report:
CHEDDAR_DB_PATH=/opt/data/cheddar-prod.db node scripts/settlement-roi-report.js

# Filter to a single sport:
CHEDDAR_DB_PATH=/opt/data/cheddar-prod.db node scripts/settlement-roi-report.js --sport=NBA

# Override minimum settled cards threshold (default 20):
CHEDDAR_DB_PATH=/opt/data/cheddar-prod.db node scripts/settlement-roi-report.js --min-settled=10

# Show help:
node scripts/settlement-roi-report.js --help
```

Note: the script is read-only — safe to run at any time without disrupting the worker.

---

## 3. Column Definitions

| Column | Description |
|--------|-------------|
| SPORT | Sport code (NBA, NHL, MLB, NCAAM) |
| MARKET_KEY | Odds API market key (e.g. `h2h`, `spreads`, `totals`) |
| PERIOD | `FULL_GAME` or `1P` (first-period / first-half) |
| SETTLED | Total cards settled in this group (2026-01-01 onward) |
| WIN / LOSS / PUSH | Counts by result type |
| WIN_RATE | wins / (wins + losses); excludes pushes and voids |
| AVG_CLV | Average closing-line value % (null if `clv_ledger` not populated) |
| UNITS | Cumulative P&L in units (positive = profitable) |
| RECOMMENDATION | PROMOTE / WATCH / QUARANTINE / INSUFFICIENT_DATA |

---

## 4. Recommendation Thresholds

- Minimum 20 settled cards required for a recommendation (override with `--min-settled=N`)
- `PROMOTE` — win_rate > 54% (model has consistent edge)
- `WATCH` — win_rate 50–54% (slight edge, monitor)
- `QUARANTINE` — win_rate < 50% (model losing; deprioritize)
- `INSUFFICIENT_DATA` — fewer than 20 settled cards or no decidable results

**Threshold rationale:** 54% is the approximate break-even for -110 juice. Above it = positive EV. Below 50% = negative EV at any juice level.

---

## 5. Acting on the Output

### PROMOTE

Open `packages/models/src/decision-pipeline-v2-edge-config.js`, find the threshold profile for that market, and consider lowering `EDGE_MIN` or raising the promotion tier. Document your reasoning in the relevant work item.

### WATCH

No immediate action. Re-run in 2 weeks. Note the market in the relevant model work item for tracking.

### QUARANTINE

Open `packages/models/src/decision-pipeline-v2-edge-config.js` and raise `EDGE_MIN` for that market to restrict cards, or set `enabled: false` for the market key. Create a work item documenting:
- The quarantine decision
- The win_rate observed at quarantine time
- The expected re-evaluation date

---

## 6. Manual Validation Checklist

- [ ] Run on prod host; confirm script exits 0
- [ ] Confirm output is non-empty (at least one row)
- [ ] Confirm DB mtime unchanged before and after (`stat /opt/data/cheddar-prod.db | grep Modify`)
- [ ] Confirm CLV column shows "yes" if `clv_ledger` is populated, "no" otherwise (check header line)

---

## 7. Related Work Items

- **WI-0607** — market_period_token persistence at settlement (prerequisite)
- **WI-0626** — MLB F5 doubleheader fix (prerequisite)
- **WI-0557** — CLV ledger wiring (prerequisite)
- **WI-0648** — MLB empirical sigma recalibration gate (likely QUARANTINE candidate)
