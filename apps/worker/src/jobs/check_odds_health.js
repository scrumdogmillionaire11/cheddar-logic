/**
 * Odds Health Check
 *
 * Verifies that pull_odds_hourly has succeeded recently.
 * Exits non-zero when odds pipeline appears stale.
 *
 * Env:
 * - ODDS_HEALTH_MAX_AGE_MINUTES (default: 90)
 */

require('dotenv').config();
const { initDb, getJobRunHistory } = require('@cheddar-logic/data');

function getLatestSuccessfulRun(jobRuns) {
  return jobRuns.find((run) => run && run.status === 'success') || null;
}

async function checkOddsHealth() {
  const maxAgeMinutes = Number(process.env.ODDS_HEALTH_MAX_AGE_MINUTES || 90);

  await initDb();

  const history = getJobRunHistory('pull_odds_hourly', 200);
  const latestSuccess = getLatestSuccessfulRun(history);

  if (!latestSuccess || !latestSuccess.started_at) {
    console.error(
      '[OddsHealth] CRITICAL: no successful pull_odds_hourly run found in history',
    );
    return {
      ok: false,
      reason: 'no-successful-run',
      lastSuccessAt: null,
      ageMinutes: null,
      maxAgeMinutes,
    };
  }

  const lastSuccessAt = latestSuccess.started_at;
  const ageMinutes = Math.floor(
    (Date.now() - new Date(lastSuccessAt).getTime()) / 60000,
  );
  const ok = ageMinutes <= maxAgeMinutes;

  if (ok) {
    console.log(
      `[OddsHealth] OK: last successful pull_odds_hourly at ${lastSuccessAt} (${ageMinutes}m ago, threshold ${maxAgeMinutes}m)`,
    );
  } else {
    console.error(
      `[OddsHealth] STALE: last successful pull_odds_hourly at ${lastSuccessAt} (${ageMinutes}m ago, threshold ${maxAgeMinutes}m)`,
    );
  }

  return {
    ok,
    reason: ok ? 'fresh' : 'stale',
    lastSuccessAt,
    ageMinutes,
    maxAgeMinutes,
  };
}

if (require.main === module) {
  checkOddsHealth()
    .then((result) => {
      process.exit(result.ok ? 0 : 1);
    })
    .catch((error) => {
      console.error('[OddsHealth] ERROR:', error.message);
      process.exit(2);
    });
}

module.exports = { checkOddsHealth };
