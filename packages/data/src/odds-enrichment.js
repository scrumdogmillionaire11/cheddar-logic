/**
 * Odds Enrichment Module
 *
 * Fetches ESPN team metrics and merges them into odds snapshots
 * for use by driver models.
 */

const { getTeamMetricsWithGames } = require('./team-metrics');

function logOddsEnrichmentEvent(event, payload) {
  try {
    console.warn(`[OddsEnrichment][${event}] ${JSON.stringify(payload)}`);
  } catch {
    console.warn(`[OddsEnrichment][${event}]`);
  }
}

function hasNumericEspnMetrics(metrics) {
  if (!metrics || typeof metrics !== 'object') return false;
  const keys = [
    'avgPoints',
    'avgPointsAllowed',
    'avgGoalsFor',
    'avgGoalsAgainst',
    'freeThrowPct',
  ];
  return keys.some((key) => {
    const value = metrics[key];
    if (value === null || value === undefined || value === '') return false;
    const parsed = Number(value);
    return Number.isFinite(parsed);
  });
}

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

function isEspnTeamMetricsSport(sport) {
  return sport === 'NBA' || sport === 'NHL' || sport === 'NCAAM';
}

function parseRawData(rawData) {
  if (!rawData) return {};
  try {
    return typeof rawData === 'string' ? JSON.parse(rawData) : rawData;
  } catch {
    return {};
  }
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
    const strictTeamMapping = options.strict_team_mapping !== false;

    // MLB and other non-ESPN-team-metrics sports should not emit source mapping
    // failures from this enrichment path.
    if (!isEspnTeamMetricsSport(espnSport)) {
      const rawData = parseRawData(oddsSnapshot.raw_data);
      const enriched = {
        ...oddsSnapshot,
        raw_data: {
          ...rawData,
          espn_metrics: {
            ...(rawData.espn_metrics && typeof rawData.espn_metrics === 'object'
              ? rawData.espn_metrics
              : {}),
            source_contract: {
              strict_team_mapping: strictTeamMapping,
              mapping_ok: true,
              mapping_failures: [],
              mapping_skipped: true,
              mapping_skip_reason: 'unsupported_sport',
              sport: espnSport,
            },
          },
        },
      };
      if (typeof oddsSnapshot.raw_data === 'string') {
        enriched.raw_data = JSON.stringify(enriched.raw_data);
      }
      return enriched;
    }

    const [homeData, awayData] = await Promise.all([
      getTeamMetricsWithGames(oddsSnapshot.home_team, espnSport, {
        includeGames,
        limit: gameLimit,
        strictVariantMatch: strictTeamMapping,
      }).catch(err => {
        console.warn(`[OddsEnrichment] Home team ERROR for ${oddsSnapshot.home_team} (${oddsSnapshot.game_id}): ${err.message}`);
        return null;
      }),
      getTeamMetricsWithGames(oddsSnapshot.away_team, espnSport, {
        includeGames,
        limit: gameLimit,
        strictVariantMatch: strictTeamMapping,
      }).catch(err => {
        console.warn(`[OddsEnrichment] Away team ERROR for ${oddsSnapshot.away_team} (${oddsSnapshot.game_id}): ${err.message}`);
        return null;
      })
    ]);

    // Check for null/incomplete metrics (neutral() returns)
    const hasHomeMetrics = hasNumericEspnMetrics(homeData?.metrics);
    const hasAwayMetrics = hasNumericEspnMetrics(awayData?.metrics);

    if (!hasHomeMetrics || !hasAwayMetrics) {
      logOddsEnrichmentEvent('NULL_TEAM_METRICS', {
        gameId: oddsSnapshot.game_id,
        sport: oddsSnapshot.sport,
        homeTeam: oddsSnapshot.home_team,
        awayTeam: oddsSnapshot.away_team,
        hasHomeMetrics,
        hasAwayMetrics,
        homeResolutionStatus: homeData?.resolution?.status || null,
        awayResolutionStatus: awayData?.resolution?.status || null,
        strictTeamMapping,
      });
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

    // Guard: if the new fetch produced no numeric metrics for either side, check whether
    // the snapshot already has valid ESPN metrics from a prior enrichment. If so, preserve
    // them rather than overwriting with null values — this prevents a transient ESPN
    // lookup failure from destroying previously good cached data.
    if (!hasHomeMetrics || !hasAwayMetrics) {
      const existingEspn = rawData.espn_metrics;
      const existingHomeOk = hasNumericEspnMetrics(existingEspn?.home?.metrics);
      const existingAwayOk = hasNumericEspnMetrics(existingEspn?.away?.metrics);
      if (existingHomeOk && existingAwayOk) {
        logOddsEnrichmentEvent('PRESERVING_EXISTING_ESPN_METRICS', {
          gameId: oddsSnapshot.game_id,
          sport: oddsSnapshot.sport,
          homeTeam: oddsSnapshot.home_team,
          awayTeam: oddsSnapshot.away_team,
          reason: 'new_fetch_returned_null_metrics_existing_metrics_intact',
        });
        return oddsSnapshot;
      }
    }

    const mappingFailures = [];
    if (homeData?.resolution?.status && homeData.resolution.status !== 'ok') {
      mappingFailures.push({ side: 'home', team: oddsSnapshot.home_team, ...homeData.resolution });
    }
    if (awayData?.resolution?.status && awayData.resolution.status !== 'ok') {
      mappingFailures.push({ side: 'away', team: oddsSnapshot.away_team, ...awayData.resolution });
    }

    if (mappingFailures.length > 0) {
      logOddsEnrichmentEvent('SOURCE_CONTRACT_FAILURE_TEAM_MAPPING', {
        gameId: oddsSnapshot.game_id,
        sport: oddsSnapshot.sport,
        homeTeam: oddsSnapshot.home_team,
        awayTeam: oddsSnapshot.away_team,
        failures: mappingFailures,
      });
    }

    // Merge ESPN metrics into raw_data
    const enriched = {
      ...oddsSnapshot,
      raw_data: {
        ...rawData,
        espn_metrics: {
          fetched_at: new Date().toISOString(),
          source_contract: {
            strict_team_mapping: strictTeamMapping,
            mapping_ok: mappingFailures.length === 0,
            mapping_failures: mappingFailures,
          },
          home: {
            metrics: homeData?.metrics || null,
            team_info: homeData?.teamInfo || null,
            recent_games: includeGames ? (homeData?.games || []) : undefined
          },
          away: {
            metrics: awayData?.metrics || null,
            team_info: awayData?.teamInfo || null,
            recent_games: includeGames ? (awayData?.games || []) : undefined
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
