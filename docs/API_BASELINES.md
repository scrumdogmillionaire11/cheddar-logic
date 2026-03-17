# API Baselines

Captured: 2026-02-27

## GET /api/cards?sport=nhl&limit=20

Command:

```bash
curl -i "http://localhost:8080/api/cards?sport=nhl&limit=20" | head -n 40
```

Response:

```http
HTTP/1.1 200 OK
vary: rsc, next-router-state-tree, next-router-prefetch, next-router-segment-prefetch
content-type: application/json
Date: Fri, 27 Feb 2026 16:08:42 GMT
Connection: keep-alive
Keep-Alive: timeout=5
Transfer-Encoding: chunked

{"success":true,"data":[{"id":"card-nhl-nhl-2026-02-27-van-sea-d67402a9","gameId":"nhl-2026-02-27-van-sea","sport":"NHL","cardType":"nhl-model-output","cardTitle":"NHL Model: AWAY","createdAt":"2026-02-27T16:08:36.728Z","expiresAt":null,"payloadData":{"game_id":"nhl-2026-02-27-van-sea","sport":"NHL","model_version":"nhl-model-v1","prediction":"AWAY","confidence":0.65,"reasoning":"Model prefers AWAY team at 0.65 confidence","odds_context":{"h2h_home":2,"h2h_away":1.95,"spread_home":-0.5,"spread_away":0.5,"total":5.5,"captured_at":"2026-02-27T15:29:45.468Z"},"ev_passed":true,"disclaimer":"Analysis provided for educational purposes. Not a recommendation.","generated_at":"2026-02-27T16:08:36.728Z","meta":{"inference_source":"mock","model_endpoint":null,"is_mock":true}},"payloadParseError":false,"modelOutputIds":"model-nhl-nhl-2026-02-27-van-sea-6d29d95d"},{"id":"card-nhl-nhl-2026-02-27-tor-mtl-cbb69ce6","gameId":"nhl-2026-02-27-tor-mtl","sport":"NHL","cardType":"nhl-model-output","cardTitle":"NHL Model: HOME","createdAt":"2026-02-27T16:08:36.713Z","expiresAt":null,"payloadData":{"game_id":"nhl-2026-02-27-tor-mtl","sport":"NHL","model_version":"nhl-model-v1","prediction":"HOME","confidence":0.65,"reasoning":"Model prefers HOME team at 0.65 confidence","odds_context":{"h2h_home":1.85,"h2h_away":2.1,"spread_home":-1.5,"spread_away":1.5,"total":6.5,"captured_at":"2026-02-27T15:29:45.468Z"},"ev_passed":true,"disclaimer":"Analysis provided for educational purposes. Not a recommendation.","generated_at":"2026-02-27T16:08:36.713Z","meta":{"inference_source":"mock","model_endpoint":null,"is_mock":true}},"payloadParseError":false,"modelOutputIds":"model-nhl-nhl-2026-02-27-tor-mtl-8d7a2121"},{"id":"card-nhl-nhl-2026-02-27-edm-cgy-aa7986c0","gameId":"nhl-2026-02-27-edm-cgy","sport":"NHL","cardType":"nhl-model-output","cardTitle":"NHL Model: HOME","createdAt":"2026-02-27T16:08:36.695Z","expiresAt":null,"payloadData":{"game_id":"nhl-2026-02-27-edm-cgy","sport":"NHL","model_version":"nhl-model-v1","prediction":"HOME","confidence":0.65,"reasoning":"Model prefers HOME team at 0.65 confidence","odds_context":{"h2h_home":1.75,"h2h_away":2.25,"spread_home":-1.5,"spread_away":1.5,"total":6,"captured_at":"2026-02-27T15:29:45.468Z"},"ev_passed":true,"disclaimer":"Analysis provided for educational purposes. Not a recommendation.","generated_at":"2026-02-27T16:08:36.695Z","meta":{"inference_source":"mock","model_endpoint":null,"is_mock":true}},"payloadParseError":false,"modelOutputIds":"model-nhl-nhl-2026-02-27-edm-cgy-07141999"}]}
```

## GET /api/cards?include_expired=true&card_type=nhl-model-output

Command:

```bash
curl -i "http://localhost:8080/api/cards?include_expired=true&card_type=nhl-model-output" | head -n 40
```

Response:

```http
HTTP/1.1 200 OK
vary: rsc, next-router-state-tree, next-router-prefetch, next-router-segment-prefetch
content-type: application/json
Date: Fri, 27 Feb 2026 16:08:42 GMT
Connection: keep-alive
Keep-Alive: timeout=5
Transfer-Encoding: chunked

{"success":true,"data":[{"id":"card-nhl-nhl-2026-02-27-van-sea-d67402a9","gameId":"nhl-2026-02-27-van-sea","sport":"NHL","cardType":"nhl-model-output","cardTitle":"NHL Model: AWAY","createdAt":"2026-02-27T16:08:36.728Z","expiresAt":null,"payloadData":{"game_id":"nhl-2026-02-27-van-sea","sport":"NHL","model_version":"nhl-model-v1","prediction":"AWAY","confidence":0.65,"reasoning":"Model prefers AWAY team at 0.65 confidence","odds_context":{"h2h_home":2,"h2h_away":1.95,"spread_home":-0.5,"spread_away":0.5,"total":5.5,"captured_at":"2026-02-27T15:29:45.468Z"},"ev_passed":true,"disclaimer":"Analysis provided for educational purposes. Not a recommendation.","generated_at":"2026-02-27T16:08:36.728Z","meta":{"inference_source":"mock","model_endpoint":null,"is_mock":true}},"payloadParseError":false,"modelOutputIds":"model-nhl-nhl-2026-02-27-van-sea-6d29d95d"},{"id":"card-nhl-nhl-2026-02-27-tor-mtl-cbb69ce6","gameId":"nhl-2026-02-27-tor-mtl","sport":"NHL","cardType":"nhl-model-output","cardTitle":"NHL Model: HOME","createdAt":"2026-02-27T16:08:36.713Z","expiresAt":null,"payloadData":{"game_id":"nhl-2026-02-27-tor-mtl","sport":"NHL","model_version":"nhl-model-v1","prediction":"HOME","confidence":0.65,"reasoning":"Model prefers HOME team at 0.65 confidence","odds_context":{"h2h_home":1.85,"h2h_away":2.1,"spread_home":-1.5,"spread_away":1.5,"total":6.5,"captured_at":"2026-02-27T15:29:45.468Z"},"ev_passed":true,"disclaimer":"Analysis provided for educational purposes. Not a recommendation.","generated_at":"2026-02-27T16:08:36.713Z","meta":{"inference_source":"mock","model_endpoint":null,"is_mock":true}},"payloadParseError":false,"modelOutputIds":"model-nhl-nhl-2026-02-27-tor-mtl-8d7a2121"},{"id":"card-nhl-nhl-2026-02-27-edm-cgy-aa7986c0","gameId":"nhl-2026-02-27-edm-cgy","sport":"NHL","cardType":"nhl-model-output","cardTitle":"NHL Model: HOME","createdAt":"2026-02-27T16:08:36.695Z","expiresAt":null,"payloadData":{"game_id":"nhl-2026-02-27-edm-cgy","sport":"NHL","model_version":"nhl-model-v1","prediction":"HOME","confidence":0.65,"reasoning":"Model prefers HOME team at 0.65 confidence","odds_context":{"h2h_home":1.75,"h2h_away":2.25,"spread_home":-1.5,"spread_away":1.5,"total":6,"captured_at":"2026-02-27T15:29:45.468Z"},"ev_passed":true,"disclaimer":"Analysis provided for educational purposes. Not a recommendation.","generated_at":"2026-02-27T16:08:36.695Z","meta":{"inference_source":"mock","model_endpoint":null,"is_mock":true}},"payloadParseError":false,"modelOutputIds":"model-nhl-nhl-2026-02-27-edm-cgy-07141999"}]}
```

## GET /api/cards/nhl-2026-02-27-van-sea?limit=10

Command:

```bash
curl -i "http://localhost:8080/api/cards/nhl-2026-02-27-van-sea?limit=10" | head -n 60
```

Response:

```http
HTTP/1.1 200 OK
vary: rsc, next-router-state-tree, next-router-prefetch, next-router-segment-prefetch
content-type: application/json
Date: Fri, 27 Feb 2026 16:08:42 GMT
Connection: keep-alive
Keep-Alive: timeout=5
Transfer-Encoding: chunked

{"success":true,"data":[{"id":"card-nhl-nhl-2026-02-27-van-sea-d67402a9","gameId":"nhl-2026-02-27-van-sea","sport":"NHL","cardType":"nhl-model-output","cardTitle":"NHL Model: AWAY","createdAt":"2026-02-27T16:08:36.728Z","expiresAt":null,"payloadData":{"game_id":"nhl-2026-02-27-van-sea","sport":"NHL","model_version":"nhl-model-v1","prediction":"AWAY","confidence":0.65,"reasoning":"Model prefers AWAY team at 0.65 confidence","odds_context":{"h2h_home":2,"h2h_away":1.95,"spread_home":-0.5,"spread_away":0.5,"total":5.5,"captured_at":"2026-02-27T15:29:45.468Z"},"ev_passed":true,"disclaimer":"Analysis provided for educational purposes. Not a recommendation.","generated_at":"2026-02-27T16:08:36.728Z","meta":{"inference_source":"mock","model_endpoint":null,"is_mock":true}},"payloadParseError":false,"modelOutputIds":"model-nhl-nhl-2026-02-27-van-sea-6d29d95d"}]}
```

## Telemetry Baselines (Operational)

These checks are used by the inefficient-model replacement runbook.

### projection_perf_ledger baseline

Command:

```bash
set -a; source .env; set +a; sqlite3 "$CHEDDAR_DB_PATH" "
SELECT
  sport,
  decision_basis,
  COUNT(*) AS sample_size,
  ROUND(AVG(CASE WHEN won = 1 THEN 1.0 ELSE 0.0 END), 4) AS win_rate
FROM projection_perf_ledger
WHERE settled_at IS NOT NULL
  AND datetime(settled_at) >= datetime('now', '-14 days')
GROUP BY sport, decision_basis
ORDER BY sample_size DESC;
"
```

Expected:

- `decision_basis` should be `PROJECTION_ONLY`.
- Query returns zero or more rows depending on recent settlements.

### clv_ledger baseline

Command:

```bash
set -a; source .env; set +a; sqlite3 "$CHEDDAR_DB_PATH" "
SELECT
  sport,
  market_type,
  decision_basis,
  COUNT(*) AS sample_size,
  ROUND(AVG(clv_pct), 4) AS mean_clv
FROM clv_ledger
WHERE closed_at IS NOT NULL
  AND datetime(closed_at) >= datetime('now', '-14 days')
GROUP BY sport, market_type, decision_basis
ORDER BY sample_size DESC;
"
```

Expected:

- `decision_basis` should be `ODDS_BACKED` only.
- `PROJECTION_ONLY` count should remain zero by design.
