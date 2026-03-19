'use strict';
require('dotenv').config();

const path = require('path');
const { spawn } = require('child_process');
const { v4: uuidV4 } = require('uuid');
const {
  insertJobRun,
  markJobRunSuccess,
  markJobRunFailure,
  withDb,
  upsertSoccerTeamXg,
} = require('@cheddar-logic/data');

const JOB_NAME = 'pull_soccer_xg_stats';
const PYTHON_SCRIPT = path.resolve(
  __dirname,
  '../../scripts/fetch_fbref_xg.py',
);

/**
 * Resolve the Python executable to use.
 * Respects PYTHON_BIN env var; falls back to python3 → python.
 */
function getPythonBin() {
  return process.env.PYTHON_BIN || 'python3';
}

/**
 * Spawn the FBref xG Python bridge.
 * Resolves with parsed JSON array on success.
 * Resolves with [] on non-zero exit (fail-open behavior per spec).
 *
 * @returns {Promise<Array>}
 */
function runPythonFetch() {
  return new Promise((resolve) => {
    const pythonBin = getPythonBin();
    let stdout = '';
    let stderr = '';

    const proc = spawn(pythonBin, [PYTHON_SCRIPT], {
      env: { ...process.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    proc.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });

    proc.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    proc.on('close', (code) => {
      // Emit Python stderr lines (informational) at appropriate log level
      if (stderr.trim()) {
        for (const line of stderr.trim().split('\n')) {
          if (line.includes('WARNING') || code !== 0) {
            console.warn(`[${JOB_NAME}] Python: ${line}`);
          } else {
            console.log(`[${JOB_NAME}] Python: ${line}`);
          }
        }
      }

      if (code !== 0) {
        console.warn(
          `[${JOB_NAME}] FBref fetch exited ${code} — xG cache will remain NULL-able (fail-open)`,
        );
        return resolve([]);
      }

      let parsed;
      try {
        const lastLine = stdout.trim().split('\n').pop();
        parsed = JSON.parse(lastLine);
      } catch (parseErr) {
        console.warn(
          `[${JOB_NAME}] Could not parse Python output: ${parseErr.message} — fail-open`,
        );
        return resolve([]);
      }

      if (!Array.isArray(parsed)) {
        console.warn(
          `[${JOB_NAME}] Python output is not an array — fail-open`,
        );
        return resolve([]);
      }

      resolve(parsed);
    });

    proc.on('error', (spawnErr) => {
      console.warn(
        `[${JOB_NAME}] Could not start Python (${pythonBin}): ${spawnErr.message} — fail-open`,
      );
      resolve([]);
    });
  });
}

/**
 * Pull rolling xG stats from FBref and cache in soccer_team_xg_cache.
 *
 * Fail-open: if FBref is unavailable, logs WARNING and returns success with
 * skipped=true. The xG cache remains NULL-able for Phase 2 fallback.
 *
 * Idempotent: running twice within the same calendar day produces the same
 * DB state (UNIQUE constraint on league + team_name + cache_date).
 *
 * @param {object} [options]
 * @param {string|null} [options.jobKey]  - Scheduler idempotency key
 * @param {boolean} [options.dryRun]      - When true, skip all DB writes
 * @returns {Promise<object>}
 */
async function pullSoccerXgStats({ jobKey = null, dryRun = false } = {}) {
  const jobRunId = `job-${JOB_NAME}-${new Date().toISOString().split('.')[0]}-${uuidV4().slice(0, 8)}`;

  const enabled =
    process.env.ENABLE_SOCCER_XG_MODEL !== 'false';

  if (!enabled) {
    console.log(
      `[${JOB_NAME}] Skipped — set ENABLE_SOCCER_XG_MODEL=true to enable`,
    );
    return { success: true, skipped: true, reason: 'not_enabled' };
  }

  if (dryRun) {
    console.log(
      `[${JOB_NAME}] DRY_RUN — would fetch FBref rolling xG for EPL, MLS, UCL`,
    );
    return { success: true, dryRun: true };
  }

  return withDb(async () => {
    try {
      insertJobRun(JOB_NAME, jobRunId, jobKey);

      const cacheDate = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
      const fetchedAt = new Date().toISOString();

      console.log(`[${JOB_NAME}] Fetching FBref xG via Python bridge...`);
      const rows = await runPythonFetch();

      if (rows.length === 0) {
        console.warn(
          `[${JOB_NAME}] No xG data returned — xG cache unchanged (fail-open)`,
        );
        markJobRunSuccess(jobRunId, { rowsUpserted: 0, skipped: true });
        return { success: true, skipped: true, reason: 'fbref_unavailable' };
      }

      let rowsUpserted = 0;
      const leagueCounts = {};

      for (const row of rows) {
        if (!row.league || !row.team_name) continue;

        upsertSoccerTeamXg({
          league: row.league,
          teamName: row.team_name,
          homeXgL6: typeof row.home_xg_l6 === 'number' ? row.home_xg_l6 : null,
          awayXgL6: typeof row.away_xg_l6 === 'number' ? row.away_xg_l6 : null,
          fetchedAt,
          cacheDate,
        });

        rowsUpserted += 1;
        leagueCounts[row.league] = (leagueCounts[row.league] || 0) + 1;
      }

      for (const [league, count] of Object.entries(leagueCounts)) {
        console.log(`[${JOB_NAME}] ${league}: ${count} teams cached`);
      }

      markJobRunSuccess(jobRunId, { rowsUpserted, leagueCounts });
      console.log(`[${JOB_NAME}] Done: ${rowsUpserted} team xG rows upserted`);
      return { success: true, rowsUpserted, leagueCounts };
    } catch (error) {
      console.error(`[${JOB_NAME}] Job failed: ${error.message}`);
      try {
        markJobRunFailure(jobRunId, { error: error.message });
      } catch (_) {
        // ignore secondary failure
      }
      return { success: false, error: error.message };
    }
  });
}

if (require.main === module) {
  const dryRun = process.argv.includes('--dry-run');
  pullSoccerXgStats({ dryRun })
    .then((result) => process.exit(result.success ? 0 : 1))
    .catch((error) => {
      console.error(error);
      process.exit(1);
    });
}

module.exports = {
  pullSoccerXgStats,
};
