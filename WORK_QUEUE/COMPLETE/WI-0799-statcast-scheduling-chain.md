# WI-0799: Verify and fix MLB statcast scheduling chain — ensure swstr_pct lands before model runs

**ID**: WI-0799
**Goal**: Confirm that `pull_mlb_statcast.js` runs before `run_mlb_model.js` in the scheduler chain and that `season_swstr_pct` / `season_avg_velo` are non-null for active starters; fix any ordering or dependency gap.

**Scope**:

- `apps/worker/src/schedulers/player-props.js` (statcast job ordering)
- `apps/worker/src/jobs/pull_mlb_statcast.js`
- `apps/worker/src/jobs/run_mlb_model.js` (comment at line 1202)

**Out of scope**:

- Statcast column migrations (already exist via `pull_mlb_pitcher_stats.js` creating rows first)
- Changes to the model's K-prop logic
- WI-0790 statcast regression tests (complete)

**Acceptance**:

- `pull_mlb_statcast.js` is scheduled to run as part of the MLB morning ingest window (09:00 ET), after `pull_mlb_pitcher_stats.js` and before `run_mlb_model.js`
- In the scheduler, `pull_mlb_statcast` job key is registered in the correct sequence
- After a full daily run on the Pi, `SELECT COUNT(*) FROM mlb_pitcher_stats WHERE season_swstr_pct IS NOT NULL` returns > 0
- The comment "null until pull_mlb_statcast is added" in `run_mlb_model.js` line 1202 is removed or updated to reflect the current state

**Owner agent**: unassigned
**Time window**: TBD
**Coordination flag**: solo

**Tests to run**:

- `npm --prefix apps/worker run test -- --testPathPattern mlb-k-statcast`
- `npm --prefix apps/worker run test -- --testPathPattern scheduler-windows`

**Manual validation**:

- SSH to Pi; after 09:00 ET run: `sqlite3 /opt/data/cheddar-prod.db "SELECT COUNT(*) FROM mlb_pitcher_stats WHERE season_swstr_pct IS NOT NULL;"`
- Confirm at least one pitcher has non-null statcast data

**Guard for WI closeout**:

- Scheduler logs show `pull_mlb_statcast` completing before `run_mlb_model` on the same morning window
- DB verification query returns > 0 rows on Pi

CLAIM: unassigned
