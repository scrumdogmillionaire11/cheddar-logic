/**
 * Refresh Team Metrics Daily Job
 *
 * Prewarm the daily team metrics cache by fetching ESPN data for all active teams
 * across NBA, NHL, and NCAAM. This reduces API call volume during model runs
 * and stabilizes projection inputs.
 *
 * Refresh window: 09:00 ET fixed window (aligned with first model run)
 * Cache TTL: 1 day (overwritten at next refresh)
 * Retry logic: Failed fetches are not cached, allowing retry on next model run
 *
 * Usage:
 *   node src/jobs/refresh_team_metrics_daily.js
 *   node src/jobs/refresh_team_metrics_daily.js --dry-run
 *   node src/jobs/refresh_team_metrics_daily.js --sport=NBA
 */

'use strict';

require('dotenv').config();
const { v4: uuidV4 } = require('uuid');
const { DateTime } = require('luxon');

const {
  insertJobRun,
  markJobRunSuccess,
  markJobRunFailure,
  shouldRunJobKey,
  withDb,
  getDatabase,
  deleteStaleTeamMetricsCache,
} = require('@cheddar-logic/data');

const {
  getTeamMetricsWithGames,
} = require('../../../../packages/data/src/team-metrics');

// Sport configurations
const SPORTS = [
  {
    sport: 'NBA',
    teams: [
      'Atlanta Hawks',
      'Boston Celtics',
      'Brooklyn Nets',
      'Charlotte Hornets',
      'Chicago Bulls',
      'Cleveland Cavaliers',
      'Dallas Mavericks',
      'Denver Nuggets',
      'Detroit Pistons',
      'Golden State Warriors',
      'Houston Rockets',
      'Indiana Pacers',
      'LA Clippers',
      'Los Angeles Lakers',
      'Memphis Grizzlies',
      'Miami Heat',
      'Milwaukee Bucks',
      'Minnesota Timberwolves',
      'New Orleans Pelicans',
      'New York Knicks',
      'Oklahoma City Thunder',
      'Orlando Magic',
      'Philadelphia 76ers',
      'Phoenix Suns',
      'Portland Trail Blazers',
      'Sacramento Kings',
      'San Antonio Spurs',
      'Toronto Raptors',
      'Utah Jazz',
      'Washington Wizards',
    ],
  },
  {
    sport: 'NHL',
    teams: [
      'Anaheim Ducks',
      'Boston Bruins',
      'Buffalo Sabres',
      'Calgary Flames',
      'Carolina Hurricanes',
      'Chicago Blackhawks',
      'Colorado Avalanche',
      'Columbus Blue Jackets',
      'Dallas Stars',
      'Detroit Red Wings',
      'Edmonton Oilers',
      'Florida Panthers',
      'Los Angeles Kings',
      'Minnesota Wild',
      'Montreal Canadiens',
      'Nashville Predators',
      'New Jersey Devils',
      'New York Islanders',
      'New York Rangers',
      'Ottawa Senators',
      'Philadelphia Flyers',
      'Pittsburgh Penguins',
      'San Jose Sharks',
      'Seattle Kraken',
      'St. Louis Blues',
      'Tampa Bay Lightning',
      'Toronto Maple Leafs',
      'Vancouver Canucks',
      'Vegas Golden Knights',
      'Washington Capitals',
      'Winnipeg Jets',
      'Utah Hockey Club',
    ],
  },
  {
    sport: 'NCAAM',
    teams: [
      // Top 50 teams from 2024-25 season (can be extended)
      'Duke',
      'Kansas',
      'North Carolina',
      'Kentucky',
      'Gonzaga',
      'Purdue',
      'Houston',
      'Alabama',
      'Tennessee',
      'UCLA',
      'Arizona',
      'Baylor',
      'Creighton',
      'UConn',
      'Marquette',
      'Texas',
      'Illinois',
      'Auburn',
      'Iowa State',
      'San Diego State',
      "Saint Mary's",
      'Michigan State',
      'Wisconsin',
      'Virginia',
      'Florida Atlantic',
      'Arkansas',
      'Northwestern',
      'Memphis',
      'TCU',
      'Xavier',
      'Indiana',
      'Maryland',
      'Missouri',
      'Texas A&M',
      'Clemson',
      'Utah State',
      'Colorado State',
      'Drake',
      'VCU',
      'Dayton',
    ],
  },
];

const STALE_DAYS = 7; // Delete cache entries older than 7 days

/**
 * Main job execution
 */
async function run() {
  const runId = uuidV4();
  const dryRun = process.argv.includes('--dry-run');
  const sportFilter = process.argv
    .find((arg) => arg.startsWith('--sport='))
    ?.split('=')[1]
    ?.toUpperCase();

  const nowEt = DateTime.now().setZone('America/New_York');
  const cacheDate = nowEt.toISODate();
  const jobKey = `refresh_team_metrics|${cacheDate}`;

  console.log(
    `[RefreshTeamMetrics] Starting run_id=${runId} (date=${cacheDate}, dry_run=${dryRun})`,
  );

  if (dryRun) {
    console.log('[RefreshTeamMetrics] DRY RUN - no DB changes will be made');
  }

  // Check if job already ran today
  if (!dryRun) {
    const db = getDatabase();
    const shouldRun = shouldRunJobKey(jobKey, 20); // 20-hour window to avoid double-run
    if (!shouldRun) {
      console.log(`[RefreshTeamMetrics] Job already ran today (key=${jobKey})`);
      return;
    }
  }

  // Insert job run record
  if (!dryRun) {
    insertJobRun('refresh_team_metrics_daily', runId, jobKey);
  }

  try {
    const sportsToRefresh = sportFilter
      ? SPORTS.filter((s) => s.sport === sportFilter)
      : SPORTS;

    if (sportsToRefresh.length === 0) {
      throw new Error(`Unknown sport filter: ${sportFilter}`);
    }

    let totalTeams = 0;
    let successCount = 0;
    let failedCount = 0;
    const failed = [];

    for (const { sport, teams } of sportsToRefresh) {
      console.log(
        `[RefreshTeamMetrics] Processing ${sport} (${teams.length} teams)...`,
      );

      for (const teamName of teams) {
        totalTeams++;

        try {
          // Fetch and cache team metrics (skipCache=true to force fresh fetch)
          const result = await getTeamMetricsWithGames(teamName, sport, {
            includeGames: true,
            limit: 5,
            skipCache: false, // Use cache if available (for re-runs), but will write fresh data
          });

          if (result.resolution?.status === 'ok') {
            successCount++;
            console.log(`  ✓ ${teamName} (id=${result.resolution.teamId})`);
          } else {
            failedCount++;
            failed.push({
              sport,
              teamName,
              reason: result.resolution?.status || 'unknown',
            });
            console.warn(
              `  ✗ ${teamName} (reason=${result.resolution?.status || 'unknown'})`,
            );
          }

          // Small delay to avoid ESPN rate limiting
          await new Promise((r) => setTimeout(r, 250));
        } catch (err) {
          failedCount++;
          failed.push({ sport, teamName, reason: err.message });
          console.error(`  ✗ ${teamName} - ERROR: ${err.message}`);
        }
      }
    }

    // Clean up stale cache entries
    if (!dryRun) {
      const staleDate = nowEt.minus({ days: STALE_DAYS }).toISODate();
      const deletedCount = deleteStaleTeamMetricsCache(staleDate);
      console.log(
        `[RefreshTeamMetrics] Deleted ${deletedCount} stale cache entries (before ${staleDate})`,
      );
    }

    const summary = {
      runId,
      cacheDate,
      totalTeams,
      successCount,
      failedCount,
      failedTeams: failed,
    };

    console.log(
      '[RefreshTeamMetrics] Summary:',
      JSON.stringify(summary, null, 2),
    );

    if (!dryRun) {
      markJobRunSuccess(runId, summary);
    }

    console.log(
      `[RefreshTeamMetrics] Complete (success=${successCount}/${totalTeams})`,
    );

    // Exit with error code if too many failures
    if (failedCount > totalTeams * 0.2) {
      console.error(
        `[RefreshTeamMetrics] WARN: High failure rate (${failedCount}/${totalTeams})`,
      );
      process.exit(1);
    }
  } catch (err) {
    console.error('[RefreshTeamMetrics] Job failed:', err);

    if (!dryRun) {
      markJobRunFailure(runId, err.message);
    }

    process.exit(1);
  }
}

// Run if invoked directly
if (require.main === module) {
  withDb(run).catch((err) => {
    console.error('[RefreshTeamMetrics] Uncaught error:', err);
    process.exit(1);
  });
}

module.exports = { run };
