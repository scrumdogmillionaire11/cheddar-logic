'use strict';

/**
 * run_projection_accuracy_report
 *
 * Generates a proxy-line accuracy report for settled MLB F5 and NHL 1P
 * projection cards. Reads from projection_proxy_evals, logs a structured
 * summary per card family, and returns the summary object.
 *
 * Not scheduled by default. Run on-demand:
 *   node apps/worker/src/jobs/run_projection_accuracy_report.js
 *   or: node -e "require('@cheddar-logic/worker').runProjectionAccuracyReport()"
 * Or call from report_settlement_health.js as a follow-on.
 */

const { getDatabase, getProjectionAccuracySummary } = require('@cheddar-logic/data');
// Both re-exported from packages/data/index.js (WI-0864). getDatabase() uses CHEDDAR_DB_PATH internally.

const REPORT_FAMILIES = ['MLB_F5_TOTAL', 'NHL_1P_TOTAL'];
const DEFAULT_LOOKBACK_DAYS = 90;

async function run({ lookbackDays = DEFAULT_LOOKBACK_DAYS } = {}) {
  const db = getDatabase();  // uses CHEDDAR_DB_PATH internally — same as all other worker jobs

  const gameDateGte = new Date(Date.now() - lookbackDays * 24 * 60 * 60 * 1000)
    .toISOString()
    .split('T')[0];

  const reports = [];

  for (const cardFamily of REPORT_FAMILIES) {
    const summary = getProjectionAccuracySummary(db, { cardFamily, gameDateGte });
    reports.push(summary);

    console.log(
      JSON.stringify({
        event: 'PROJECTION_ACCURACY_REPORT',
        card_family: cardFamily,
        lookback_days: lookbackDays,
        game_date_gte: gameDateGte,
        ...summary,
      })
    );
  }

  return reports;
}

module.exports = { run };

if (require.main === module) {
  run().catch((err) => {
    console.error('[run_projection_accuracy_report] fatal', err);
    process.exit(1);
  });
}
