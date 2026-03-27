# Market Registry

**Status:** Authoritative
**Last updated:** 2026-03-27
**Owner:** @ajcolubiale

This document is the single source of truth for which markets are supported per sport, their current wiring status, and what is on the roadmap. All model, pipeline, and display-layer decisions should reference this registry when determining what is in scope.

---

## Legend

| Symbol | Meaning |
| --- | --- |
| ✅ | Fully wired — ingested, modeled, decision-gated, displayed |
| ⚙️ | Partially wired — model logic exists but pipeline has gaps |
| 🗺️ | Roadmap — scoped intent, not yet wired |
| ❌ | Out of scope / sunset |

---

## NHL

**Primary game market:** TOTAL
**Secondary game market:** ML
**Specialty markets:** FIRST_PERIOD (1P) total, Player Shots, (roadmap) Player Blocks

| Market | Type | Status | Notes |
| --- | --- | --- | --- |
| Total (full game) | Game | ✅ | DUAL_RUN selected; primary market |
| Moneyline | Game | ✅ | DUAL_RUN secondary; requires price + edge |
| Spread | Game | ✅ | DUAL_RUN tertiary; requires price + edge |
| First Period Total (1P) | Game | ⚙️ | Driver fires (`nhl-pace-1p`); blocked unless 1P market price + edge present (WI-0553) |
| Player Shots on Goal | Player Prop | ✅ | Separate pipeline (`pull_nhl_player_shots`); own model and card type |
| Player Blocks | Player Prop | 🗺️ | Roadmap; same architecture as Player Shots |

**Key constraints:**

- FIRST_PERIOD cards require a 1P total line and edge >= `lean_edge_min` — projection signal alone is not sufficient (WI-0553).
- Player props are independent of game-level DUAL_RUN market selection.

---

## NBA

**Primary game market:** TOTAL
**Secondary game market:** SPREAD

| Market | Type | Status | Notes |
| --- | --- | --- | --- |
| Total (full game) | Game | ✅ | DUAL_RUN selected; primary market |
| Spread | Game | ✅ | DUAL_RUN secondary |
| Moneyline | Game | ✅ | DUAL_RUN tertiary |
| PRA (Points + Rebounds + Assists) | Player Prop | 🗺️ | Next-season roadmap |
| Points | Player Prop | 🗺️ | Next-season roadmap |
| Rebounds | Player Prop | 🗺️ | Next-season roadmap |
| Assists | Player Prop | 🗺️ | Next-season roadmap |

**Key constraints:**

- Pace-synergy (`nba-pace-synergy`) and rest-advantage (`nba-rest-advantage`) drivers are TOTAL/SPREAD scoped only.
- Player props will follow the same driver isolation pattern established for NHL shots.

---

## MLB

**Primary game market:** F5 Total
**Secondary game market:** F5 Moneyline (not yet wired)
**Primary player market:** Pitcher Strikeouts

| Market | Type | Status | Notes |
| --- | --- | --- | --- |
| F5 Total (first 5 innings) | Game | ⚙️ | Model wired (`projectF5TotalCard`); `total_f5` ingested from odds snapshot; no DUAL_RUN-style selection or dedicated pipeline health check |
| F5 Moneyline | Game | ✅ | `ml_f5_home`/`ml_f5_away` ingested; `projectF5ML` projects side from ERA matchup vs. implied prob; emits `mlb-f5-ml` card when edge clears threshold (WI-0603) |
| Pitcher Strikeouts (home) | Player Prop | ✅ | Full pipeline; projection + market structure + trap scan |
| Pitcher Strikeouts (away) | Player Prop | ✅ | Full pipeline; projection + market structure + trap scan |
| Full-game Total | Game | ❌ | Not a target market — full-game pitching context degrades after 5th inning |
| Full-game Spread / ML | Game | ❌ | Out of scope for current model |

**Key gaps (backlog):**

1. **No DUAL_RUN market selection** — F5 Total and Pitcher K cards currently compete as peers; F5 should be elevated as the primary game market with Ks treated as props.
2. ~~**F5 ML not ingested**~~ — Resolved in WI-0603: `ml_f5_home`/`ml_f5_away` now ingested and modeled.
3. **No pipeline health differentiation** for F5 — `WATCHDOG_MARKET_UNAVAILABLE` does not distinguish between a missing full-game total and a missing F5 total (WI-0604).

---

## Soccer

**Primary game market:** Asian Handicap / ML

See `docs/SOCCER_MODEL_SPECIFICATION.md` and ADR-0006 for scope boundaries.

---

## NCAAM

**Primary market:** Full-game Spread (free-throw rate model)

See `docs/NCAAM_FT_SPREAD_MODEL.md`.

---

## FPL (Fantasy Premier League)

Not a betting market. Separate pipeline. See `docs/FPL_DASHBOARD.md`.

---

## Cross-Sport Rules

- **All game-level markets** must be routed through `decision-pipeline-v2.js` with edge gating before a card reaches CHEDDAR status.
- **Projection-signal-only paths to CHEDDAR are prohibited.** This was the root cause closed by WI-0553 for NHL 1P, and is the design intent for all markets.
- **Player props are always additive** to game-level market selection — they never compete with game markets in the same DUAL_RUN pass.
- **`ENABLE_WITHOUT_ODDS_MODE=true`** (dev env default) allows model runs without live odds. All cards will show `odds_ok: false` and `WATCHDOG_MARKET_UNAVAILABLE`. This is expected behaviour, not a bug.
