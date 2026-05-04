# Card Visibility Integrity Audit — 2026-05-02 Incident Snapshot

## Scope

- Audit captured: `2026-05-03T12:45:00Z`
- Audit window: `2026-04-25T00:00:00Z` through `2026-05-03T00:00:00Z`
- Data source: local baseline snapshot resolved by the worker (`packages/data/cheddar.db`)
  - This artifact is an incident baseline, not a production-authority snapshot.
  - Production-authority validation must use `CHEDDAR_DB_PATH=/opt/data/cheddar-prod.db`.
- Classification contract: current worker display-enrollment rules
  - `ENROLLED`: display-eligible `PLAY` / `LEAN` row with `card_display_log`
  - `PROJECTION_ONLY`: payload explicitly marked `PROJECTION_ONLY`
  - `NOT_DISPLAY_ELIGIBLE`: row does not satisfy current display-enrollment contract
  - `DISPLAY_LOG_NOT_ENROLLED`: display-eligible row with no `card_display_log` row

The filename keeps the `2026-05-02` incident date. The snapshot itself was captured on `2026-05-03`.

## Counts

| Metric | Count |
| --- | ---: |
| Total audited rows | 15,153 |
| Total actionable recent rows (`ENROLLED + DISPLAY_LOG_NOT_ENROLLED`) | 679 |
| `ENROLLED` | 426 |
| `PROJECTION_ONLY` | 9,124 |
| `NOT_DISPLAY_ELIGIBLE` | 5,350 |
| `DISPLAY_LOG_NOT_ENROLLED` | 253 |

## Representative IDs

| Bucket | Representative card IDs |
| --- | --- |
| `ENROLLED` | `card-nhl-paceTotals-c5c914c5b8c28d64ff00b6e65dbd3831-9c4eb4d0`, `card-mlb-mlb-full-game-153461ac6d07b9cf3c047b0052a27400-1742cac2`, `potd-card-2026-05-01` |
| `PROJECTION_ONLY` | `nhl-player-sog-8483445-401869778-full-f687b569`, `nhl-player-sog-8482699-401869767-full-f727d0c2`, `nhl-player-sog-8482699-401869763-full-8332ec2b` |
| `NOT_DISPLAY_ELIGIBLE` | `card-nhl-scoringEnvironment-c5c914c5b8c28d64ff00b6e65dbd3831-15a8cd57`, `card-nhl-lineupInjury-c5c914c5b8c28d64ff00b6e65dbd3831-47886d39`, `card-nhl-goalieCertainty-c5c914c5b8c28d64ff00b6e65dbd3831-7b0357d0` |
| `DISPLAY_LOG_NOT_ENROLLED` | `card-mlb-mlb-full-game-d4c3dbfeab9d45e50dea2e86b3da477a-0438770f`, `card-mlb-mlb-full-game-99cbbfbfd9560db3b77799bea7dfc475-1293cca2`, `card-mlb-mlb-full-game-eb5e5ee05cf9e2c9e3df8f51d9835b52-45d0cacf` |

## Notes

- Historical `DISPLAY_LOG_NOT_ENROLLED` rows are now explicit known-bad history. They must remain excluded from display-proofed surfaces unless separate live-display proof exists for the exact row.
- The audit does **not** authorize blanket backfill.
- WI-1232 fixed the forward write path. This audit preserves the pre-fix miss set as an operational baseline and gives the watchdog a concrete comparison point for future regressions.
