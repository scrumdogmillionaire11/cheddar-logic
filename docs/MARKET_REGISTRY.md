# Market Registry

**Status:** Authoritative
**Last updated:** 2026-04-02
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
| First Period Total (1P) | Game | ⚙️ | Projection-only lane for now; live 1P odds ingestion removed to avoid alternate-market token burn |
| Player Shots on Goal | Player Prop | ⚙️ | Projection-only lane for now; model and card type stay active, Odds API prop ingestion removed |
| Player Blocks | Player Prop | 🗺️ | Roadmap; same architecture as Player Shots |

**Key constraints:**

- FIRST_PERIOD cards remain visible as a projection-only research lane; they do not consume live Odds API 1P pricing.
- NHL player props remain independent of game-level DUAL_RUN selection, but they currently run without live prop-line ingestion.

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

**Primary game market:** F5 Total (projection-only for now)
**Primary player market:** Pitcher Strikeouts

| Market | Type | Status | Notes |
| --- | --- | --- | --- |
| F5 Total (first 5 innings) | Game | ⚙️ | Projection-only lane; live F5 odds ingestion removed |
| Pitcher Strikeouts (home) | Player Prop | ⚙️ | Projection-only lane; live prop pull removed |
| Pitcher Strikeouts (away) | Player Prop | ⚙️ | Same projection-only posture as home side |
| F5 Moneyline | Game | ❌ | Out of scope — not a target market |
| Full-game Total | Game | ❌ | Not a target market — full-game pitching context degrades after 5th inning |
| Full-game Spread / ML | Game | ❌ | Out of scope |

**Key constraints:**

1. MLB F5 and pitcher-K cards are intentionally projection-only until a quota-safe featured-market strategy exists.
2. Deprecated `odds_snapshots` F5 columns remain for compatibility but are no longer populated by the shared odds fetcher.

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
- **Projection-only exceptions are explicit.** NHL 1P, NHL player shots, MLB F5, and MLB pitcher K are currently research lanes and must not re-introduce live event-level odds fetches without a dedicated work item.
- **Player props are always additive** to game-level market selection — they never compete with game markets in the same DUAL_RUN pass.
- **`ENABLE_WITHOUT_ODDS_MODE=true`** (dev env default) allows model runs without live odds. All cards will show `odds_ok: false` and `WATCHDOG_MARKET_UNAVAILABLE`. This is expected behaviour, not a bug.
