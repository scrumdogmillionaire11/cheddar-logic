# Quick Task 165: WI-1013 - Resolve stale reason code alias confusion

**Status:** Complete
**Implementation commit:** 4616cc1b

## Summary

Completed the stale reason-code migration to canonical codes:

- `STALE_MARKET` is now emitted/checked instead of stale-market aliases.
- `STALE_SNAPSHOT` is now emitted/checked instead of watchdog snapshot aliases.
- `REASON_CODE_ALIASES` is retained as an empty legacy export only; source validators no longer consult aliases.
- UI labels are canonical-only.
- Web read paths normalize historical DB rows to canonical stale codes before display.

## Validation

- `npm --prefix packages/data test -- reason-codes --runInBand` - passed
- `npm --prefix packages/models test -- decision-pipeline-v2-stale-odds --runInBand` - passed
- `npm --prefix packages/models test -- decision-policy --runInBand` - passed
- `npm --prefix apps/worker test -- run_nhl_model.market-calls --runInBand` - passed
- `npm --prefix apps/worker test -- decision-publisher.v2 --runInBand` - passed
- `npm --prefix web run build` - passed
- `grep -rn "MARKET_DATA_STALE\|STALE_MARKET_INPUT\|WATCHDOG_STALE_SNAPSHOT" apps/ packages/ web/src/ --include="*.js" --include="*.ts"` - only documented historical DB normalizer comments remain

## Scope Check

Changed files are within `WORK_QUEUE/WI-1013.md` scope, including the GSD quick-task artifacts added before code edits.
