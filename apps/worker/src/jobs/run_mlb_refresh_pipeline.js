'use strict';

/**
 * MLB Refresh Pipeline
 *
 * Runs the canonical MLB refresh chain in order so manual operations cannot
 * accidentally omit a required step.
 *
 * Sequence:
 * 1) pull_odds_hourly
 * 2) pull_mlb_pitcher_stats
 * 3) pull_mlb_statcast
 * 4) pull_mlb_weather
 * 5) run_mlb_model
 */

require('dotenv').config();

const { pullOddsHourly } = require('./pull_odds_hourly');
const { pullMlbPitcherStats } = require('./pull_mlb_pitcher_stats');
const { pullMlbStatcast } = require('./pull_mlb_statcast');
const { pullMlbWeather } = require('./pull_mlb_weather');
const { runMLBModel } = require('./run_mlb_model');

function buildPipelineSteps() {
  return [
    { name: 'pull_odds_hourly', execute: pullOddsHourly },
    { name: 'pull_mlb_pitcher_stats', execute: pullMlbPitcherStats },
    { name: 'pull_mlb_statcast', execute: pullMlbStatcast },
    { name: 'pull_mlb_weather', execute: pullMlbWeather },
    { name: 'run_mlb_model', execute: runMLBModel },
  ];
}

async function runMlbRefreshPipeline({ jobKey, dryRun = false } = {}) {
  const runKey =
    jobKey ||
    `mlb-refresh-pipeline-${new Date().toISOString().replace(/[.:]/g, '-')}`;
  const startedAt = Date.now();
  const steps = buildPipelineSteps();

  console.log(`[MLBPipeline] Starting ${runKey} (${steps.length} steps)`);

  for (const step of steps) {
    const stepJobKey = `${runKey}|${step.name}`;
    console.log(`[MLBPipeline] -> ${step.name}`);

    const result = await step.execute({ jobKey: stepJobKey, dryRun });
    if (result && result.success === false) {
      throw new Error(
        `${step.name} failed: ${result.error || 'unknown error'}`,
      );
    }
  }

  const elapsedMs = Date.now() - startedAt;
  console.log(`[MLBPipeline] Completed ${runKey} in ${elapsedMs}ms`);
  return { success: true, jobKey: runKey, elapsedMs };
}

if (require.main === module) {
  runMlbRefreshPipeline()
    .then(() => process.exit(0))
    .catch((error) => {
      console.error('[MLBPipeline] Fatal:', error.message);
      process.exit(1);
    });
}

module.exports = {
  buildPipelineSteps,
  runMlbRefreshPipeline,
};
