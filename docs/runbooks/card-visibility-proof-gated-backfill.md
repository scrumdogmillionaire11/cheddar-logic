# Card Visibility Proof-Gated Backfill Runbook

## Intent

This runbook exists for one case only: a specific historical row has external proof that it was shown live, but `card_display_log` is missing. The remediation path is row-specific, proof-gated, and manual.

Bulk or heuristic backfill is prohibited.

## Acceptable proof

Any remediation ticket must attach one of these for the exact `pick_id` or an exact card/title+game+timestamp match:

- Archived `/api/games` or `/wedge` response payload captured while the card was live
- UI screenshot or HTML capture with timestamp and visible card details
- Operator log or Discord post that includes the exact card identity and live timestamp
- Structured observability artifact that ties the exact `pick_id` to a live surface event

These are not sufficient on their own:

- `PLAY` or `LEAN` status in `card_payloads`
- Settlement presence in `card_results`
- Model output existence without live-display evidence

## Safety rules

- Set `CHEDDAR_DB_PATH=/opt/data/cheddar-prod.db`.
- Stop the worker before touching the production DB. The worker is the only writer and owns the DB lock in normal operation.
- Never enable `CHEDDAR_DB_ALLOW_MULTI_PROCESS=true` in production to bypass the lock.
- Backfill only rows listed explicitly in a proof ticket.
- Do not run a wildcard, time-window, sport-wide, or card-type-wide insert.

## Exact command sequence

### 1. Stop the worker

Use the normal service-management path for the host. Do not continue until the active writer is down and `/opt/data/cheddar-prod.db.lock` is no longer owned by the worker.

### 2. Set the canonical DB path

```bash
export CHEDDAR_DB_PATH=/opt/data/cheddar-prod.db
```

### 3. Start a sqlite session

```bash
sqlite3 "$CHEDDAR_DB_PATH"
```

### 4. Register only the proof-approved rows

Replace the example values with the exact approved rows and proof metadata.

```sql
CREATE TEMP TABLE proof_gated_display_backfill (
  pick_id TEXT PRIMARY KEY,
  proof_ref TEXT NOT NULL,
  proof_displayed_at TEXT NOT NULL,
  reviewed_by TEXT NOT NULL
);

INSERT INTO proof_gated_display_backfill (pick_id, proof_ref, proof_displayed_at, reviewed_by)
VALUES
  ('example-pick-id', 'INC-2026-05-02 screenshot 03', '2026-05-01T23:54:06.374Z', 'operator-name');
```

### 5. Preview before writing

This must return only the approved rows and must show `existing_display_log_id` as `NULL`.

```sql
SELECT
  p.pick_id,
  p.proof_ref,
  p.proof_displayed_at,
  cp.game_id,
  cp.sport,
  cp.card_type,
  cp.card_title,
  cp.run_id,
  cdl.id AS existing_display_log_id
FROM proof_gated_display_backfill p
JOIN card_payloads cp ON cp.id = p.pick_id
LEFT JOIN card_display_log cdl ON cdl.pick_id = p.pick_id;
```

### 6. Insert only the proof-gated rows

```sql
BEGIN IMMEDIATE;

INSERT INTO card_display_log (
  pick_id,
  run_id,
  game_id,
  sport,
  market_type,
  selection,
  line,
  odds,
  odds_book,
  confidence_pct,
  displayed_at,
  api_endpoint
)
SELECT
  cp.id,
  cp.run_id,
  cp.game_id,
  cp.sport,
  UPPER(COALESCE(json_extract(cp.payload_data, '$.market_type'), '')),
  UPPER(
    COALESCE(
      json_extract(cp.payload_data, '$.selection.side'),
      json_extract(cp.payload_data, '$.selection'),
      ''
    )
  ),
  json_extract(cp.payload_data, '$.line'),
  json_extract(cp.payload_data, '$.price'),
  COALESCE(json_extract(cp.payload_data, '$.best_line_bookmaker'), 'proof-gated-backfill'),
  COALESCE(json_extract(cp.payload_data, '$.confidence_pct'), json_extract(cp.payload_data, '$.confidence')),
  p.proof_displayed_at,
  '/api/games'
FROM proof_gated_display_backfill p
JOIN card_payloads cp ON cp.id = p.pick_id
LEFT JOIN card_display_log cdl ON cdl.pick_id = cp.id
WHERE cdl.pick_id IS NULL;

SELECT changes() AS rows_inserted;

COMMIT;
```

### 7. Verify the exact rows after insert

```sql
SELECT
  cdl.pick_id,
  cdl.run_id,
  cdl.game_id,
  cdl.sport,
  cdl.market_type,
  cdl.selection,
  cdl.line,
  cdl.odds,
  cdl.displayed_at,
  cdl.api_endpoint
FROM card_display_log cdl
JOIN proof_gated_display_backfill p ON p.pick_id = cdl.pick_id
ORDER BY cdl.pick_id;
```

### 8. Exit sqlite and restart the worker

After verification, restart the worker through the normal service-management path.

## Prohibited actions

- No `INSERT ... SELECT` over a date range
- No sport-wide or card-type-wide backfill
- No settlement-time automatic enrollment for historical rows
- No insertion based only on `decision_v2.official_status`, `card_results`, or `card_payloads` presence
