/**
 * Odds Enrichment Module
 *
 * Fetches ESPN team metrics and merges them into odds snapshots
 * for use by driver models.
 */

const { getTeamMetricsWithGames } = require('./team-metrics');

/**
 * Map sport names: odds format to ESPN format
 * @param {string} sport - 'NBA' | 'NCAAM' | 'NHL'
 * @returns {string}
 */
function mapOddsSportToEspnSport(sport) {
  if (sport === 'NCAAM' || sport === 'NCAA' || sport === 'NCAAB') return 'NCAAM';
  return sport;
}

/**
 * Enrich a single odds snapshot with ESPN team metrics.
 * Fetches metrics for both home and away teams, merges into raw_data.
 * On error, returns snapshot unchanged.
 *
 * @param {object} oddsSnapshot - Game odds snapshot
 * @param {object} options
 * @param {boolean} [options.include_games=false] - Include recent games in raw_data
 * @param {number} [options.game_limit=5] - Number of recent games to fetch
 * @returns {Promise<object>} Enriched snapshot
 */
async function enrichOddsSnapshotWithEspnMetrics(oddsSnapshot, options = {}) {
  if (!oddsSnapshot?.home_team || !oddsSnapshot?.away_team || !oddsSnapshot?.sport) {
    return oddsSnapshot;
  }

  try {
    const espnSport = mapOddsSportToEspnSport(oddsSnapshot.sport);
    const includeGames = options.include_games === true;
    const gameLimit = Number.isFinite(options.game_limit) ? options.game_limit : 5;

    const [homeData, awayData] = await Promise.all([
      getTeamMetricsWithGames(oddsSnapshot.home_team, espnSport, {
        includeGames,
        limit: gameLimit
      }),
      getTeamMetricsWithGames(oddsSnapshot.away_team, espnSport, {
        includeGames,
        limit: gameLimit
      })
    ]);

    // Parse existing raw_data or create new object
    let rawData = {};
    if (oddsSnapshot.raw_data) {
      try {
        rawData = typeof oddsSnapshot.raw_data === 'string'
          ? JSON.parse(oddsSnapshot.raw_data)
          : oddsSnapshot.raw_data;
      } catch {
        rawData = {};
      }
    }

    // Merge ESPN metrics into raw_data
    const enriched = {
      ...oddsSnapshot,
      raw_data: {
        ...rawData,
        espn_metrics: {
          fetched_at: new Date().toISOString(),
          home: {
            metrics: homeData.metrics,
            team_info: homeData.teamInfo,
            recent_games: includeGames ? homeData.games : undefined
          },
          away: {
            metrics: awayData.metrics,
            team_info: awayData.teamInfo,
            recent_games: includeGames ? awayData.games : undefined
          }
        }
      }
    };

    // Convert raw_data to JSON string if it's in the DB format
    if (typeof oddsSnapshot.raw_data === 'string') {
      enriched.raw_data = JSON.stringify(enriched.raw_data);
    }

    return enriched;
  } catch (err) {
    console.warn(`[OddsEnrichment] Error enriching ${oddsSnapshot?.game_id}: ${err.message}`);
    return oddsSnapshot;
  }
}

/**
 * Enrich multiple odds snapshots with ESPN metrics (parallel).
 *
 * @param {Array<object>} oddsSnapshots
 * @param {object} options
 * @returns {Promise<Array<object>>}
 */
async function enrichOddsSnapshotsWithEspnMetrics(oddsSnapshots, options = {}) {
  if (!Array.isArray(oddsSnapshots)) return [];
  return Promise.all(
    oddsSnapshots.map(snap => enrichOddsSnapshotWithEspnMetrics(snap, options))
  );
}

module.exports = {
  enrichOddsSnapshotWithEspnMetrics,
  enrichOddsSnapshotsWithEspnMetrics
};
