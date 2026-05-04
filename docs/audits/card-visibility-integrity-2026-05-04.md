# Card Visibility Integrity Audit — 2026-05-04

## Scope

- Audit captured: `2026-05-04T11:15:03Z`
- Audit window: `2026-04-27T11:15:03Z` through `2026-05-04T11:15:03Z`
- Data source: active local DB snapshot at `packages/data/cheddar.db`
- Audit intent: classify every recent `card_payloads` row into exactly one current-path visibility bucket without changing thresholds, canonical guards, or settlement inclusion policy

## Classification Contract

- `PROJECTION_ONLY`
  - Explicit projection-only family or execution lane (`card_type LIKE 'mlb-f5%'`, `basis = PROJECTION_ONLY`, `execution_status = PROJECTION_ONLY`, or projection-only line source)
- `MISSING_DECISION_V2`
  - Modern-looking row still missing canonical `decision_v2.official_status`
- `NOT_DISPLAY_ELIGIBLE`
  - Row is not projection-only, is not a valid canonical pass, and does not satisfy the current display-enrollment contract
- `DISPLAY_LOG_NOT_ENROLLED`
  - Row satisfies the current display-enrollment contract but has no `card_display_log` row
- `API_FILTERED`
  - Row is enrolled in `card_display_log` but current `/api/games` actionability rules intentionally suppress it
- `UI_LABEL_MISMATCH`
  - Row survives to the UI but legacy copy/labels disagree with canonical `PLAY` / `LEAN` semantics
- `VALID_PASS`
  - Canonical `decision_v2.official_status = PASS`
- `BUG`
  - Residual anomaly that does not fit the allowed contracts above

## Counts

| Bucket | Count |
| --- | ---: |
| `PROJECTION_ONLY` | 3,620 |
| `MISSING_DECISION_V2` | 1,873 |
| `NOT_DISPLAY_ELIGIBLE` | 607 |
| `VALID_PASS` | 101 |
| `DISPLAY_LOG_NOT_ENROLLED` | 49 |
| `API_FILTERED` | 4 |
| `UI_LABEL_MISMATCH` | 0 |
| `BUG` | 1 |
| **Total classified rows** | **6,255** |

## Representative IDs

| Bucket | Representative card IDs |
| --- | --- |
| `PROJECTION_ONLY` | `nhl-player-sog-8483445-df8e2f4e8a0bfcff34d6bbd0619bc3dd-full-dbbeb9ab`, `card-nhl-paceTotals1p-644f37a134497f23c6d3821ad599b48b-9acd88ba`, `card-mlb-mlb-pitcher-k-72f79061defb394c2e533967c55edb30-668e59cb` |
| `MISSING_DECISION_V2` | `card-mlb-mlb-full-game-72f79061defb394c2e533967c55edb30-05c06e5f`, `card-mlb-mlb-full-game-ml-7401e0a3694fdfd518a0b949987e61b4-efda8335`, `card-nba-totalProjection-0d0aa62d4305ee094389473b308ce0bd-0aaa5c33` |
| `NOT_DISPLAY_ELIGIBLE` | `card-mlb-mlb-full-game-ba204fb233ca7bb67ee89a3dd893e188-809ef5bd`, `card-mlb-mlb-full-game-ml-b713b3ae079ed7d21c2a9f7edb043f6b-e81c5319`, `card-nhl-scoringEnvironment-df8e2f4e8a0bfcff34d6bbd0619bc3dd-a762ec93` |
| `DISPLAY_LOG_NOT_ENROLLED` | `card-mlb-mlb-full-game-d4c3dbfeab9d45e50dea2e86b3da477a-0438770f`, `card-mlb-mlb-full-game-99cbbfbfd9560db3b77799bea7dfc475-1293cca2`, `card-mlb-mlb-full-game-ml-781a040a058473c689200f515770de83-464a62df` |
| `API_FILTERED` | `card-nhl-totals-call-df8e2f4e8a0bfcff34d6bbd0619bc3dd`, `card-nhl-totals-call-dd40fd7156c9a60a0ce8365206fc9310`, `card-nba-totals-call-912bee9cc9d36b6017819f012c0c56f1` |
| `UI_LABEL_MISMATCH` | none observed |
| `VALID_PASS` | `card-nhl-scoringEnvironment-6ff22480704fc10dca4fb5f56513a4f4-0be25295`, `card-nhl-lineupInjury-6ff22480704fc10dca4fb5f56513a4f4-8125ddee`, `card-nhl-goalieCertainty-6ff22480704fc10dca4fb5f56513a4f4-8bab53fa` |
| `BUG` | `card-nba-spread-call-b3eb8f644d05290981f8805f5410f24a` |

## Bucket Notes

- `PROJECTION_ONLY` is dominated by `mlb-f5`, `mlb-f5-ml`, `mlb-pitcher-k`, NHL player-prop rows, and `nhl-pace-1p` rows carrying `execution_status = PROJECTION_ONLY` or equivalent projection-only line sources.
- `MISSING_DECISION_V2` is concentrated in legacy/degraded model families that still emit modern-looking payloads without canonical `decision_v2`, especially `mlb-full-game`, `mlb-full-game-ml`, `nba-base-projection`, `nba-total-projection`, and NHL projection/goalie families.
- `DISPLAY_LOG_NOT_ENROLLED` is concentrated in executable MLB totals (`43` rows), plus smaller `mlb-full-game-ml` (`3`) and `nhl-totals-call` (`3`) clusters. These are the remaining rows that satisfy the current enrollment contract but never got `card_display_log` proof.
- `API_FILTERED` is a small historical residue: enrolled `PLAY` / `LEAN` totals calls now blocked by current read-path actionability rules (`execution_status = BLOCKED` plus PASS-style legacy labels).
- `BUG` is a single enrolled canonical `PASS` row (`card-nba-spread-call-b3eb8f644d05290981f8805f5410f24a`), which should not recur under the current forward write-path tests.

## SQL Used

```sql
WITH recent AS (
  SELECT
    cp.id,
    cp.card_type,
    cp.created_at,
    UPPER(COALESCE(json_extract(cp.payload_data, '$.kind'), 'PLAY')) AS kind,
    UPPER(COALESCE(
      json_extract(cp.payload_data, '$.decision_v2.official_status'),
      json_extract(cp.payload_data, '$.play.decision_v2.official_status'),
      ''
    )) AS official_status,
    UPPER(COALESCE(json_extract(cp.payload_data, '$.status'), '')) AS legacy_status,
    UPPER(COALESCE(json_extract(cp.payload_data, '$.action'), '')) AS legacy_action,
    UPPER(COALESCE(json_extract(cp.payload_data, '$.classification'), '')) AS legacy_classification,
    UPPER(COALESCE(
      json_extract(cp.payload_data, '$.basis'),
      json_extract(cp.payload_data, '$.decision_basis'),
      json_extract(cp.payload_data, '$.decision_basis_meta.decision_basis'),
      ''
    )) AS explicit_basis,
    UPPER(COALESCE(
      json_extract(cp.payload_data, '$.execution_status'),
      json_extract(cp.payload_data, '$.play.execution_status'),
      json_extract(cp.payload_data, '$.prop_display_state'),
      ''
    )) AS execution_status,
    LOWER(COALESCE(
      json_extract(cp.payload_data, '$.decision_basis_meta.market_line_source'),
      json_extract(cp.payload_data, '$.market_context.wager.line_source'),
      json_extract(cp.payload_data, '$.line_source'),
      ''
    )) AS line_source,
    UPPER(COALESCE(
      json_extract(cp.payload_data, '$.market_type'),
      json_extract(cp.payload_data, '$.market_context.market_type'),
      json_extract(cp.payload_data, '$.recommended_bet_type'),
      ''
    )) AS market_type_raw,
    UPPER(COALESCE(
      json_extract(cp.payload_data, '$.selection.side'),
      json_extract(cp.payload_data, '$.selection'),
      ''
    )) AS selection_side,
    CAST(json_extract(cp.payload_data, '$.line') AS REAL) AS line_value,
    CAST(json_extract(cp.payload_data, '$.price') AS REAL) AS price_value,
    UPPER(COALESCE(
      json_extract(cp.payload_data, '$.period'),
      json_extract(cp.payload_data, '$.time_period'),
      json_extract(cp.payload_data, '$.market.period'),
      json_extract(cp.payload_data, '$.market_context.period'),
      json_extract(cp.payload_data, '$.market_context.wager.period'),
      ''
    )) AS period_token,
    CASE WHEN EXISTS (
      SELECT 1 FROM card_display_log cdl WHERE cdl.pick_id = cp.id
    ) THEN 1 ELSE 0 END AS enrolled
  FROM card_payloads cp
  WHERE datetime(cp.created_at) >= datetime('now', '-7 days')
),
normalized AS (
  SELECT
    *,
    CASE
      WHEN market_type_raw IN ('MONEYLINE', 'ML', 'H2H') THEN 'MONEYLINE'
      WHEN market_type_raw IN ('SPREAD', 'PUCKLINE', 'PUCK_LINE') THEN 'SPREAD'
      WHEN market_type_raw IN ('TOTAL', 'TOTALS', 'OVER_UNDER', 'OU', 'FIRST_PERIOD', '1P', 'P1') THEN 'TOTAL'
      ELSE market_type_raw
    END AS market_type,
    CASE
      WHEN period_token IN ('1P', 'P1', 'FIRST_PERIOD', '1ST_PERIOD')
        OR market_type_raw IN ('FIRST_PERIOD', '1P', 'P1')
      THEN 1 ELSE 0
    END AS is_first_period,
    CASE
      WHEN card_type LIKE 'mlb-f5%'
        OR explicit_basis = 'PROJECTION_ONLY'
        OR execution_status = 'PROJECTION_ONLY'
        OR line_source IN ('projection_floor', 'synthetic_fallback')
      THEN 1 ELSE 0
    END AS is_projection_only,
    CASE
      WHEN official_status IN ('PLAY', 'LEAN') THEN 1
      WHEN official_status = '' AND legacy_status IN ('PLAY', 'FIRE', 'LEAN') THEN 1
      ELSE 0
    END AS is_actionable_for_enrollment,
    CASE
      WHEN official_status = '' AND (
        legacy_status IN ('PLAY', 'FIRE', 'LEAN', 'WATCH')
        OR legacy_action IN ('PLAY', 'FIRE', 'LEAN', 'HOLD')
        OR legacy_classification = 'LEAN'
      ) THEN 1 ELSE 0
    END AS looks_modern_but_missing_decision
  FROM recent
),
classified AS (
  SELECT
    *,
    CASE
      WHEN is_projection_only = 1 THEN 'PROJECTION_ONLY'
      WHEN official_status = 'PASS' AND enrolled = 1 THEN 'BUG'
      WHEN official_status = 'PASS' THEN 'VALID_PASS'
      WHEN looks_modern_but_missing_decision = 1 THEN 'MISSING_DECISION_V2'
      WHEN enrolled = 1
        AND official_status IN ('PLAY', 'LEAN')
        AND execution_status = 'BLOCKED'
      THEN 'API_FILTERED'
      WHEN enrolled = 1
        AND official_status = 'LEAN'
        AND (
          legacy_status NOT IN ('WATCH', 'LEAN', 'PASS')
          OR legacy_action NOT IN ('HOLD', 'LEAN', 'PASS')
          OR legacy_classification NOT IN ('LEAN', 'PASS', '')
        )
      THEN 'UI_LABEL_MISMATCH'
      WHEN enrolled = 0
        AND kind = 'PLAY'
        AND is_actionable_for_enrollment = 1
        AND market_type = 'MONEYLINE'
        AND selection_side IN ('HOME', 'AWAY')
        AND price_value IS NOT NULL
      THEN 'DISPLAY_LOG_NOT_ENROLLED'
      WHEN enrolled = 0
        AND kind = 'PLAY'
        AND is_actionable_for_enrollment = 1
        AND market_type = 'SPREAD'
        AND selection_side IN ('HOME', 'AWAY')
        AND line_value IS NOT NULL
        AND price_value IS NOT NULL
      THEN 'DISPLAY_LOG_NOT_ENROLLED'
      WHEN enrolled = 0
        AND kind = 'PLAY'
        AND is_actionable_for_enrollment = 1
        AND market_type = 'TOTAL'
        AND selection_side IN ('OVER', 'UNDER')
        AND line_value IS NOT NULL
        AND (price_value IS NOT NULL OR is_first_period = 1)
      THEN 'DISPLAY_LOG_NOT_ENROLLED'
      ELSE 'NOT_DISPLAY_ELIGIBLE'
    END AS bucket
  FROM normalized
)
SELECT bucket, COUNT(*) AS count
FROM classified
GROUP BY bucket
ORDER BY count DESC, bucket;
```

## Conclusions

- The current forward-path code on this branch is consistent with the scoped tests: no new `UI_LABEL_MISMATCH` rows were observed, and the only residual `BUG` count is a single historical enrolled canonical `PASS`.
- The dominant live integrity debt is not a threshold problem. It is split between explicit projection-only families (`3,620` rows), legacy families still missing canonical `decision_v2` (`1,873` rows), and a smaller historical `DISPLAY_LOG_NOT_ENROLLED` residue (`49` rows).
- Historical `DISPLAY_LOG_NOT_ENROLLED` rows remain known-bad history only. This audit does not authorize blanket backfill into `card_display_log` or any relaxation of `/results` display-proof requirements.
