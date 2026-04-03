# ADR-0009: MLB Pitcher-K Free Line Sourcing

## Status
Accepted

## Context
ADR-0008 keeps `mlb-pitcher-k` runtime output in `PROJECTION_ONLY` mode because the prior paid Odds API prop pulls were removed to stop event-level quota burn. The follow-up decision is whether a free source exists that can restore ODDS_BACKED comparisons without reintroducing token spend or brittle, opaque ingestion.

There is no clean free structured MLB pitcher strikeout odds API suitable for production ingestion today. DraftKings and FanDuel expose sportsbook prices through consumer web surfaces, but those pages are not a stable public data API and may be protected by bot controls or terms that restrict automated scraping. OddsTrader and OddsJam can surface pitcher-K prices in free web UI/article contexts, but free access is incomplete and still subject to HTML/JS parser drift.

Relevant source-risk references:
- FanDuel terms prohibit use of a "robot, spider, scraper" without written permission: https://www.fanduel.com/fanfest-app-terms
- OddsTrader MLB prop content exists on public pages, but those pages are article/UI surfaces, not a documented odds API: https://www.oddstrader.com/betting/analysis/mlb-player-props-for-july-27/

## Decision
Use a **DK/FD-first, aggregator-fallback** source policy for future pitcher-K line ingestion.

### Source preference
1. DraftKings direct book scrape
2. FanDuel direct book scrape
3. OddsTrader UI scrape as fallback
4. OddsJam free UI scrape as fallback

Direct book lines are preferred because they preserve the true sportsbook book/price context. Aggregator pages are fallback-only because they may repackage delayed or incomplete book ladders and can drift independently from source books.

### Dormant line contract
Define the future standard + alt-line contract now, but keep runtime publication pinned to `PROJECTION_ONLY` until a later implementation WI explicitly enables ODDS_BACKED cards.

```json
{
  "pitcher_k_line_contract": {
    "line": 7.5,
    "over_price": -112,
    "under_price": -108,
    "bookmaker": "draftkings",
    "line_source": "draftkings",
    "opening_line": 7.5,
    "opening_over_price": -110,
    "opening_under_price": -110,
    "best_available_line": 8.0,
    "best_available_over_price": -145,
    "best_available_under_price": 120,
    "best_available_bookmaker": "fanduel",
    "current_timestamp": "2026-04-03T01:15:00Z",
    "alt_lines": [
      {
        "line": 8.0,
        "side": "under",
        "juice": 120,
        "book": "fanduel",
        "source": "fanduel",
        "captured_at": "2026-04-03T01:15:00Z"
      },
      {
        "line": 6.5,
        "side": "over",
        "juice": -145,
        "book": "draftkings",
        "source": "draftkings",
        "captured_at": "2026-04-03T01:15:00Z"
      }
    ]
  }
}
```

Storage can reuse `player_prop_lines` without a migration because the unique key already includes `(sport, game_id, player_name, prop_type, period, bookmaker, line)`, which can represent both standard and alt lines. Worker enrichment should group those rows into `raw_data.mlb.strikeout_lines[normalized_pitcher_name]` and normalize them into `pitcher_k_line_contract`.

### Activation gate
This ADR does **not** turn on live pitcher-K execution. Until a later WI ships a scraper job and parser-health guardrails:
- `resolvePitcherKsMode()` remains hard-pinned to `PROJECTION_ONLY`
- `mlb-pitcher-k` payloads with `basis='PROJECTION_ONLY'` must not carry `pitcher_k_line_contract`
- Dormant ODDS_BACKED validation and parser helpers may exist, but publishability remains blocked

### Guardrails required before enabling live scrape
- Rate limit per source and per game page, with exponential backoff on 403/429/parser errors
- Reject lines older than `MLB_K_PROP_FRESHNESS_MINUTES`
- Emit parser-health metrics for missing standard line, missing one side of juice, and malformed alt ladders
- Fail closed to `PROJECTION_ONLY`/PASS if source HTML/JSON shape changes
- No authenticated scraping, no CAPTCHA bypass, and no production use if source terms prohibit automated access

## Consequences
- Future ODDS_BACKED pitcher-K work has a stable line payload and source-preference policy without changing projection math again.
- Current runtime remains safe and quota-free: no scraper deployment in this WI and no actionable pitcher-K card publication.
- DK/FD direct scraping may still be blocked by legal or anti-bot constraints; if so, fallback aggregator scraping is allowed only with parser-health and staleness guards, and may still be rejected if quality is insufficient.
