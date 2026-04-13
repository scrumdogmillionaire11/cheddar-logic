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

**Primary game markets:** Full-game Total, Full-game Moneyline
**Primary player market:** Pitcher Strikeouts

| Market | Type | Status | Notes |
| --- | --- | --- | --- |
| Full-game Total | Game | ✅ | Active odds-backed lane; featured-market totals feed |
| Full-game Moneyline | Game | ✅ | Active odds-backed lane; featured-market h2h feed |
| F5 Total (first 5 innings) | Game | ⚙️ | Projection-only lane; separate from active full-game markets |
| Pitcher Strikeouts (home) | Player Prop | ⚙️ | Projection-only PASS lane; no paid Odds API prop pulls; free line sourcing deferred to a separate WI |
| Pitcher Strikeouts (away) | Player Prop | ⚙️ | Same projection-only PASS posture as home side |
| F5 Moneyline | Game | ❌ | Out of scope — not a target market |
| Full-game Spread | Game | ❌ | Out of scope |

**Key constraints:**

1. MLB full-game totals and moneyline are active odds-backed game-line lanes.
2. MLB F5 and pitcher-K remain projection-only exceptions. For pitcher Ks, current runtime emits PASS-only rows with Poisson ladder + fair-price metadata and no live line.
3. Deprecated `odds_snapshots` F5 columns remain for compatibility but are separate from active full-game featured-market odds.

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
- **Projection-only exceptions are explicit.** NHL 1P, NHL player shots, MLB F5, and MLB pitcher K are research lanes and must not re-introduce live event-level odds fetches without a dedicated work item.
- **Player props are always additive** to game-level market selection — they never compete with game markets in the same DUAL_RUN pass.
- **`ENABLE_WITHOUT_ODDS_MODE=true`** forces model runs without live odds. Active game-line sports, including MLB full-game total/ML, will downgrade to projection-only behavior in that mode. This is expected behaviour, not a bug.
