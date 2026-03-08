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
  const normalized = String(sport || '').trim().toUpperCase();
  if (normalized === 'NCAAM' || normalized === 'NCAA' || normalized === 'NCAAB') return 'NCAAM';
  if (normalized === 'NBA') return 'NBA';
  if (normalized === 'NHL') return 'NHL';
  return normalized || sport;
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
      }).catch(err => {
        console.warn(`[OddsEnrichment] Home team ERROR for ${oddsSnapshot.home_team} (${oddsSnapshot.game_id}): ${err.message}`);
        return null;
      }),
      getTeamMetricsWithGames(oddsSnapshot.away_team, espnSport, {
        includeGames,
        limit: gameLimit
      }).catch(err => {
        console.warn(`[OddsEnrichment] Away team ERROR for ${oddsSnapshot.away_team} (${oddsSnapshot.game_id}): ${err.message}`);
        return null;
      })
    ]);

    // Check for null/incomplete metrics (neutral() returns)
    const hasHomeMetrics = homeData?.metrics && Object.values(homeData.metrics).some(v => v !== null);
    const hasAwayMetrics = awayData?.metrics && Object.values(awayData.metrics).some(v => v !== null);
    
    if (!hasHomeMetrics) {
      console.warn(`[OddsEnrichment] Home team INCOMPLETE metrics for ${oddsSnapshot.home_team} (${oddsSnapshot.game_id})`);
    }
    if (!hasAwayMetrics) {
      console.warn(`[OddsEnrichment] Away team INCOMPLETE metrics for ${oddsSnapshot.away_team} (${oddsSnapshot.game_id})`);
    }

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
    console.warn(`[OddsEnrichment] FAILED for ${oddsSnapshot?.game_id} (${oddsSnapshot.home_team} vs ${oddsSnapshot.away_team}): ${err.message}`);
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
