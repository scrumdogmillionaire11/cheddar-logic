/**
 * pull_espn_games_direct — Without Odds Mode ingestion job
 *
 * In Without Odds Mode (ENABLE_WITHOUT_ODDS_MODE=true) this job replaces
 * pull_odds_hourly as the primary data ingestion source. It:
 *
 *   1. Fetches upcoming game schedules for each active sport from ESPN's
 *      public scoreboard API (no API key required, no quota cost).
 *   2. Upserts game records into the games table.
 *   3. Fetches ESPN team metrics for each game via the existing
 *      enrichOddsSnapshotWithEspnMetrics path.
 *   4. Stores synthetic odds_snapshot rows — null market odds, ESPN metrics
 *      in raw_data — so that existing model runners (getOddsWithUpcomingGames)
 *      find data without any code path changes to the data layer.
 *
 * Contract:
 *   - Game IDs use the format  espndirect_{sport}_{espnEventId}  to avoid
 *     any collision with Odds API-sourced IDs.
 *   - All produced snapshots have null prices / lines. Model runners operating
 *     in Without Odds Mode detect this and produce PROJECTION_ONLY cards.
 *   - This job records a job_run entry named 'pull_espn_games_direct' so the
 *     scheduler freshness gate (hasFreshInputsForModels) can check it.
 */

'use strict';

require('dotenv').config();

const { v4: uuidV4 } = require('uuid');
const {
  insertJobRun,
  markJobRunSuccess,
  markJobRunFailure,
  setCurrentRunId,
  upsertGame,
  insertOddsSnapshot,
  enrichOddsSnapshotWithEspnMetrics,
  withDb,
} = require('@cheddar-logic/data');

const { fetchScoreboardEvents } =
  require('../../../../packages/data/src/espn-client');

// ─── Sport config ────────────────────────────────────────────────────────────

const SPORTS_CONFIG = {
  NHL: {
    espnLeague: 'hockey/nhl',
    scoreboardOptions: null,
  },
  NBA: {
    espnLeague: 'basketball/nba',
    scoreboardOptions: null,
  },
  NCAAM: {
    espnLeague: 'basketball/mens-college-basketball',
    // groups=50 restricts to D-I schools; limit=1000 prevents pagination
    scoreboardOptions: { groups: '50', limit: '1000' },
  },
  MLB: {
    espnLeague: 'baseball/mlb',
    scoreboardOptions: null,
  },
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Format a Date as ESPN's YYYYMMDD query string.
 * @param {Date} d
 * @returns {string}
 */
function toEspnDateStr(d) {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}${m}${day}`;
}

/**
 * Extract team display name from an ESPN competitor entry.
 * Falls back through multiple name fields.
 * @param {object} competitor
 * @returns {string|null}
 */
function extractTeamName(competitor) {
  return (
    competitor?.team?.displayName ||
    competitor?.team?.shortDisplayName ||
    competitor?.team?.name ||
    null
  );
}

/**
 * Parse an ESPN scoreboard event into a normalised game descriptor.
 * Returns null if mandatory fields are missing or the game is already completed.
 * @param {object} event - ESPN scoreboard event
 * @param {string} sport - uppercase sport code ('NHL' | 'NBA' | 'NCAAM')
 * @returns {{ gameId, sport, homeTeam, awayTeam, gameTimeUtc, espnEventId }|null}
 */
function parseEspnEvent(event, sport) {
  if (!event || !event.id) return null;

  const comp = event.competitions?.[0];
  if (!comp) return null;

  // Skip already-completed games — we only want upcoming / in-progress.
  if (comp.status?.type?.completed === true) return null;

  const homeComp = comp.competitors?.find((c) => c.homeAway === 'home');
  const awayComp = comp.competitors?.find((c) => c.homeAway === 'away');
  if (!homeComp || !awayComp) return null;

  const homeTeam = extractTeamName(homeComp);
  const awayTeam = extractTeamName(awayComp);
  if (!homeTeam || !awayTeam) return null;

  // event.date is ISO 8601 UTC from ESPN  (e.g. "2026-03-25T23:00Z")
  const gameTimeUtc = event.date || comp.date;
  if (!gameTimeUtc) return null;

  const espnEventId = String(event.id);
  const gameId = `espndirect_${sport.toLowerCase()}_${espnEventId}`;

  return { gameId, sport, homeTeam, awayTeam, gameTimeUtc, espnEventId };
}

// ─── Main job ─────────────────────────────────────────────────────────────────

/**
 * Main entry point — matches the convention used by all other worker jobs.
 * @param {object} options
 * @param {string|null} options.jobKey - Idempotency key (supplied by scheduler)
 * @param {boolean} [options.dryRun=false]
 * @param {string[]} [options.sports] - Override sport list for testing
 */
async function pullEspnGamesDirect({
  jobKey = null,
  dryRun = false,
  sports: sportsOverride = null,
} = {}) {
  const jobRunId = `job-espn-direct-${new Date().toISOString().split('.')[0]}-${uuidV4().slice(0, 8)}`;

  console.log(`[EspnGamesDirect] Starting job run: ${jobRunId}`);
  if (jobKey) console.log(`[EspnGamesDirect] Job key: ${jobKey}`);

  return withDb(async () => {
    if (dryRun) {
      console.log(
        `[EspnGamesDirect] DRY_RUN=true — would run jobKey=${jobKey || 'none'}`,
      );
      return { success: true, jobRunId: null, dryRun: true, jobKey };
    }

    insertJobRun('pull_espn_games_direct', jobRunId, jobKey);
    setCurrentRunId(jobRunId);

    const errors = [];
    const kpis = {
      sportsAttempted: 0,
      gamesFound: 0,
      gamesUpserted: 0,
      snapshotsInserted: 0,
      espnEnrichmentHits: 0,
      espnEnrichmentMisses: 0,
      errors: 0,
    };

    // Fetch today + tomorrow to capture games just past midnight UTC
    const now = new Date();
    const tomorrow = new Date(now.getTime() + 24 * 60 * 60 * 1000);
    const datesToFetch = [toEspnDateStr(now), toEspnDateStr(tomorrow)];

    const activeSports = sportsOverride || Object.keys(SPORTS_CONFIG);

    for (const sport of activeSports) {
      const cfg = SPORTS_CONFIG[sport];
      if (!cfg) {
        console.warn(`[EspnGamesDirect] Unknown sport: ${sport} — skipping`);
        continue;
      }

      kpis.sportsAttempted++;
      const sportGames = new Map(); // espnEventId → parsed descriptor (dedupe across dates)

      for (const dateStr of datesToFetch) {
        try {
          const events = await fetchScoreboardEvents(
            cfg.espnLeague,
            dateStr,
            cfg.scoreboardOptions,
          );

          if (!Array.isArray(events)) continue;

          for (const event of events) {
            const descriptor = parseEspnEvent(event, sport);
            if (!descriptor) continue;
            if (sportGames.has(descriptor.espnEventId)) continue; // dedupe
            sportGames.set(descriptor.espnEventId, descriptor);
          }
        } catch (fetchErr) {
          const msg = `[EspnGamesDirect] ${sport} scoreboard fetch failed (${dateStr}): ${fetchErr.message}`;
          console.warn(msg);
          errors.push(msg);
          kpis.errors++;
        }
      }

      console.log(
        `[EspnGamesDirect] ${sport}: found ${sportGames.size} upcoming games`,
      );
      kpis.gamesFound += sportGames.size;

      for (const descriptor of sportGames.values()) {
        try {
          // Upsert game record
          const stableId = `game-${sport.toLowerCase()}-${descriptor.gameId}`;
          upsertGame({
            id: stableId,
            gameId: descriptor.gameId,
            sport: descriptor.sport,
            homeTeam: descriptor.homeTeam,
            awayTeam: descriptor.awayTeam,
            gameTimeUtc: descriptor.gameTimeUtc,
            status: 'scheduled',
          });
          kpis.gamesUpserted++;

          // Build a minimal snapshot object for ESPN enrichment.
          // All market-odds fields are null — this is intentional.
          // enrichOddsSnapshotWithEspnMetrics only needs home_team / away_team / sport.
          const syntheticSnapshot = {
            id: `odds-${sport.toLowerCase()}-${descriptor.gameId}-${uuidV4().slice(0, 8)}`,
            game_id: descriptor.gameId,
            sport: descriptor.sport,
            home_team: descriptor.homeTeam,
            away_team: descriptor.awayTeam,
            game_time_utc: descriptor.gameTimeUtc,
            captured_at: new Date().toISOString(),
            // Market odds are explicitly null in Without Odds Mode
            h2h_home: null,
            h2h_away: null,
            total: null,
            total_price_over: null,
            total_price_under: null,
            spread_home: null,
            spread_away: null,
            spread_price_home: null,
            spread_price_away: null,
            moneyline_home: null,
            moneyline_away: null,
            raw_data: null,
          };

          // Fetch ESPN team metrics
          let enriched = syntheticSnapshot;
          try {
            enriched = await enrichOddsSnapshotWithEspnMetrics(
              syntheticSnapshot,
            );
          } catch (enrichErr) {
            console.warn(
              `[EspnGamesDirect] ESPN enrichment failed for ${descriptor.gameId}: ${enrichErr.message}`,
            );
            kpis.espnEnrichmentMisses++;
          }

          // Check whether enrichment produced usable metrics
          const rawData = enriched.raw_data;
          const parsedRaw =
            rawData && typeof rawData === 'string'
              ? (() => {
                  try {
                    return JSON.parse(rawData);
                  } catch {
                    return null;
                  }
                })()
              : rawData;
          const hasHomeMetrics = Boolean(
            parsedRaw?.espn_metrics?.home?.metrics,
          );
          const hasAwayMetrics = Boolean(
            parsedRaw?.espn_metrics?.away?.metrics,
          );

          if (hasHomeMetrics && hasAwayMetrics) {
            kpis.espnEnrichmentHits++;
          } else {
            kpis.espnEnrichmentMisses++;
            console.warn(
              `[EspnGamesDirect] Missing ESPN metrics for ${descriptor.gameId} (home=${hasHomeMetrics}, away=${hasAwayMetrics}) — snapshot stored without metrics`,
            );
          }

          // Store synthetic snapshot (null odds, ESPN metrics in raw_data)
          insertOddsSnapshot({
            id: enriched.id,
            gameId: enriched.game_id,
            sport: enriched.sport,
            capturedAt: enriched.captured_at,
            h2hHome: null,
            h2hAway: null,
            h2hBook: null,
            total: null,
            totalPriceOver: null,
            totalPriceUnder: null,
            totalBook: null,
            spreadHome: null,
            spreadAway: null,
            spreadHomeBook: null,
            spreadAwayBook: null,
            spreadPriceHome: null,
            spreadPriceAway: null,
            monelineHome: null,
            monelineAway: null,
            rawData:
              typeof enriched.raw_data === 'string'
                ? enriched.raw_data
                : enriched.raw_data
                  ? JSON.stringify(enriched.raw_data)
                  : null,
            jobRunId,
          });
          kpis.snapshotsInserted++;
        } catch (gameErr) {
          const msg = `[EspnGamesDirect] ${sport}/${descriptor.gameId}: ${gameErr.message}`;
          console.warn(msg);
          errors.push(msg);
          kpis.errors++;
        }
      }
    }

    const success = errors.length === 0 || kpis.gamesUpserted > 0;
    const summary = {
      sportsAttempted: kpis.sportsAttempted,
      gamesFound: kpis.gamesFound,
      gamesUpserted: kpis.gamesUpserted,
      snapshotsInserted: kpis.snapshotsInserted,
      espnEnrichmentHits: kpis.espnEnrichmentHits,
      espnEnrichmentMisses: kpis.espnEnrichmentMisses,
      errors: errors.length,
    };

    if (success) {
      console.log(`[EspnGamesDirect] ✅ Completed — ${JSON.stringify(summary)}`);
      markJobRunSuccess(jobRunId, { summary, errors });
    } else {
      console.error(
        `[EspnGamesDirect] ❌ Failed — ${JSON.stringify(summary)}\nErrors: ${errors.join('; ')}`,
      );
      markJobRunFailure(jobRunId, errors.join('; '));
    }

    return {
      success,
      jobRunId,
      jobKey,
      summary,
      errors,
    };
  });
}

module.exports = { pullEspnGamesDirect };
