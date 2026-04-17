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

## Telemetry Calibration Report Parity (`job:report-telemetry-calibration`)

Run command:

```bash
npm --prefix apps/worker run job:report-telemetry-calibration
```

Optional enforcement mode (non-zero exit only on threshold breach):

```bash
npm --prefix apps/worker run job:report-telemetry-calibration -- --enforce
```

### Projection ledger parity checks (`projection_perf_ledger`)

```bash
set -a; source .env; set +a; sqlite3 "$CHEDDAR_DB_PATH" "
SELECT
  COUNT(*) AS sample_size,
  ROUND(AVG(CASE WHEN won = 1 THEN 1.0 ELSE 0.0 END), 4) AS win_rate,
  ROUND(AVG(CASE WHEN UPPER(COALESCE(confidence, '')) = 'HIGH' THEN CASE WHEN won = 1 THEN 1.0 ELSE 0.0 END END), 4) AS high_win_rate,
  ROUND(AVG(CASE WHEN UPPER(COALESCE(confidence, '')) = 'MEDIUM' THEN CASE WHEN won = 1 THEN 1.0 ELSE 0.0 END END), 4) AS medium_win_rate,
  ROUND(
    AVG(CASE WHEN UPPER(COALESCE(confidence, '')) = 'MEDIUM' THEN CASE WHEN won = 1 THEN 1.0 ELSE 0.0 END END)
    - AVG(CASE WHEN UPPER(COALESCE(confidence, '')) = 'HIGH' THEN CASE WHEN won = 1 THEN 1.0 ELSE 0.0 END END),
    4
  ) AS confidence_drift
FROM projection_perf_ledger
WHERE settled_at IS NOT NULL
  AND datetime(settled_at) >= datetime('now', '-14 days');
"
```

Threshold interpretation:

- Minimum sample gate: `sample_size >= 100`
- Win-rate floor: breach when `win_rate < 0.4800`
- Confidence drift: breach when `confidence_drift >= 0.0300`
- If sample gate is not met, report status is `INSUFFICIENT_DATA` (not an enforcement failure by itself).

### CLV ledger parity checks (`clv_ledger`)

```bash
set -a; source .env; set +a; sqlite3 "$CHEDDAR_DB_PATH" "
WITH windowed AS (
  SELECT clv_pct
  FROM clv_ledger
  WHERE closed_at IS NOT NULL
    AND clv_pct IS NOT NULL
    AND datetime(closed_at) >= datetime('now', '-14 days')
), ranked AS (
  SELECT
    clv_pct,
    ROW_NUMBER() OVER (ORDER BY clv_pct ASC) AS rn,
    COUNT(*) OVER () AS total
  FROM windowed
)
SELECT
  (SELECT COUNT(*) FROM windowed) AS sample_size,
  ROUND((SELECT AVG(clv_pct) FROM windowed), 4) AS mean_clv,
  ROUND((SELECT clv_pct FROM ranked WHERE rn = ((total + 3) / 4) LIMIT 1), 4) AS p25_clv;
"
```

Threshold interpretation:

- Minimum sample gate: `sample_size >= 150`
- Mean CLV: breach when `mean_clv <= -0.0200`
- Tail-risk P25: breach when `p25_clv <= -0.0500`
- If sample gate is not met, report status is `INSUFFICIENT_DATA` (the command emits diagnostics for fetch/closure coverage improvement and exits zero even with `--enforce`).

## Flip Threshold Backtest Baseline (`report_flip_threshold_backtest`, WI-0545)

Run command:

```bash
node apps/worker/src/jobs/report_flip_threshold_backtest.js --days 120 --json
```

Captured: 2026-03-22T02:34:27Z

Window dataset:

- `event_count`: `2277`
- `side_change_event_count`: `106`
- `final_game_results`: `229`

Output contract (JSON):

- Per profile counters: `flip_count`, `blocked_count`, `converted_from_edge_too_small`
- Per profile quality proxy: `graded_changed_events`, `candidate.{win,loss,push,units}`, `baseline.{win,loss,push,units}`, `delta_units`, `candidate_win_rate`

Profile comparison (120-day replay):

| Profile | EDGE_UPGRADE_MIN | flip_count | blocked_count | converted_from_edge_too_small | graded_changed_events | delta_units | candidate_win_rate |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| baseline | 0.50 | 4 | 102 | 0 | 0 | 0.00 | n/a |
| moderate | 0.25 | 4 | 102 | 0 | 0 | 0.00 | n/a |
| aggressive | 0.10 | 5 | 101 | 1 | 1 | 3.05 | 1.0000 |

Selection result:

- `selected_profile`: `baseline`
- `reason_code`: `INSUFFICIENT_SAMPLE`
- `method`: `delta_units_with_min_graded_changed_events_gate`
- `rationale`: non-baseline profiles are ineligible until `graded_changed_events >= 3`; aggressive only reached `1`.
- Sample-gate note: This gate is intentional to avoid profile changes on single-event counterfactual evidence.
- Gate constant alignment: `packages/models/src/decision-gate.js` remains unchanged at `EDGE_UPGRADE_MIN=0.5` and `CANONICAL_EDGE_CONTRACT.upgrade_min=0.5` (decimal-fraction units).

## Phase 2 Rollout Baseline (Market Thresholds V2)

Captured with `ENABLE_MARKET_THRESHOLDS_V2=false`.

### Preflight Checklist (Flag Off)

1. Confirm flag is explicitly disabled for baseline capture run:

```bash
ENABLE_MARKET_THRESHOLDS_V2=false npm --prefix apps/worker run job:run-nba-model:test
ENABLE_MARKET_THRESHOLDS_V2=false npm --prefix apps/worker run job:run-nhl-model:test
```

1. Confirm decision API behavior is stable and query contracts still match baseline expectations:

```bash
npm --prefix web run test:card-decision
npm --prefix web run test:api:games:market
```

1. Persist representative baseline artifacts for both sports (NBA and NCAAM) before any activation work starts.

### Baseline Capture Procedure

1. Run the NBA and NCAAM model test jobs with `ENABLE_MARKET_THRESHOLDS_V2=false`.
1. Capture one representative decision sample per sport from API output (payload snapshot or query transcript).
1. For each sample, record:

- `sport`
- `game_id`
- `recommendedBetType`
- `decision_basis`
- confidence/edge fields used by current contract

1. Save references in the active WI notes so activation work can compare before/after behavior.

### Required Evidence Samples

- **NBA sample (flag off):** at least one decision payload/transcript reference.
- **NCAAM sample (flag off):** at least one decision payload/transcript reference.
- Samples must reflect current expected semantics and include enough fields to evaluate parity during activation.

### Go/No-Go Gate for Activation (WI-0480)

Proceed to WI-0480 only if all conditions below are true:

1. All four preflight commands are runnable from repo root.
1. Baseline evidence exists for both NBA and NCAAM with `ENABLE_MARKET_THRESHOLDS_V2=false`.
1. No unexplained contract drift is observed in decision semantics compared to expected baseline behavior.

If any condition fails, activation is **NO-GO** and Phase 2 remains in preflight.

---

### Phase 4 Soak-Window Go/No-Go Gates (WI-0486)

This is a **separate, ongoing gate** from the one-time activation gate above. It applies during the 14–30 day soak period after both Phase 2 and Phase 3 are live.

Threshold values referenced below are defined in the table above (see [Telemetry Calibration Report Parity](#telemetry-calibration-report-parity-jobreport-telemetry-calibration)). No threshold numbers are duplicated here — consult that table for authoritative values.

> **Sample-size gate rule (critical):** A signal is only interpretable as a breach when its ledger meets the minimum row count for its ledger. Until the gate is met, `INSUFFICIENT_DATA` is returned by `--enforce` mode — this is a **pass**, not a failure. Never declare a breach on sub-gate signal data.

#### Soak Checkpoint Gates

| Checkpoint | Sample gate status | `--enforce` exit 0? | Decision |
| --- | --- | --- | --- |
| **Day 7** | Gate not yet met | `INSUFFICIENT_DATA` | **PASS** — continue soak |
| **Day 7** | Gate met | Yes | **PASS** — continue soak |
| **Day 7** | Gate met | No (breach) | **WATCH** — log breach, escalate to breach owner; do not roll back on Day 7 alone unless CLV tail-risk |
| **Day 14** | Gate not yet met | Any | **EXTEND** — move enforcement checkpoint to Day 21; log row count |
| **Day 14** | Gate met | Yes | **PASS** — continue soak |
| **Day 14** | Gate met | No (breach) | **NO-GO** — take rollback action per Breach-to-Owner Table in [DATA_PIPELINE_TROUBLESHOOTING.md](./DATA_PIPELINE_TROUBLESHOOTING.md#breach-to-owner-table) |
| **Day 30** | Gate met | Yes | **GO** — declare soak complete |
| **Day 30** | Gate met | No (breach) | **NO-GO** — full rollback; soak failed |

#### Soak Completion Criteria (GO)

Declare soak complete only when **all** of the following hold:

1. `npm --prefix apps/worker run job:report-telemetry-calibration -- --enforce` exits 0 on both Day 14/21 and Day 30.
1. No unresolved breach was logged at any prior checkpoint.
1. `npm --prefix web run test:api:games:market` passes.
1. `npm --prefix web run test:decision:canonical` passes.

#### Soak Failure Criteria (NO-GO)

Declare soak failed (execute rollback) when **any** of the following hold:

1. `--enforce` exits non-zero on Day 30 with the relevant ledger's sample gate met.
1. A CLV tail-risk breach (`p25_clv ≤ breach threshold`) is confirmed at any checkpoint with sample gate met.
1. Sample gate is still not met at Day 21 (data pipeline gap — escalate to Incident Commander).

For rollback commands and breach-specific owner assignments, see [docs/DATA_PIPELINE_TROUBLESHOOTING.md — Phase 4 Soak Runbook](./DATA_PIPELINE_TROUBLESHOOTING.md#phase-4-1430-day-telemetry-soak-runbook-wi-0486).
