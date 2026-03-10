/**
 * Settle Game Results Job
 *
 * Fetches final scores from ESPN public scoreboard for completed games
 * and upserts them into the game_results table (Gap 1 from SETTLEMENT_AUDIT.md).
 *
 * Portable job runner that can be called from:
 * - A cron job (node apps/worker/src/jobs/settle_game_results.js)
 * - A scheduler daemon (apps/worker/src/schedulers/main.js)
 * - CLI (npm run job:settle-games)
 *
 * Exit codes:
 *   0 = success
 *   1 = failure
 */

'use strict';

require('dotenv').config();
const { v4: uuidV4 } = require('uuid');
const dbBackup = require('../utils/db-backup.js');
const { ResilientESPNClient } = require('../utils/espn-resilient-client.js');
const { ScoringValidator } = require('../utils/scoring-validator.js');
const { SettlementMonitor } = require('../utils/settlement-monitor.js');

const {
  upsertGameResult,
  getDatabase,
  insertJobRun,
  markJobRunSuccess,
  markJobRunFailure,
  shouldRunJobKey,
  withDb,
} = require('@cheddar-logic/data');

const {
  fetchScoreboardEvents,
} = require('../../../../packages/data/src/espn-client');

/**
 * ESPN sport path mapping
 * Keys are uppercase sport codes from our games table
 */
const ESPN_SPORT_MAP = {
  NHL: 'hockey/nhl',
  NBA: 'basketball/nba',
  NCAAM: 'basketball/mens-college-basketball',
};

const ESPN_SCOREBOARD_OPTIONS_BY_SPORT = {
  NCAAM: { groups: '50', limit: '1000' },
};

/**
 * Environment variables for Phase 1 hardening
 */
const ESPN_API_TIMEOUT_MS = Math.max(5000, Number(process.env.ESPN_API_TIMEOUT_MS) || 30000);
const SETTLEMENT_MAX_RETRIES = Math.max(0, Number(process.env.SETTLEMENT_MAX_RETRIES) || 3);
const SETTLEMENT_MIN_HOURS_AFTER_START = Math.max(0, Number(process.env.SETTLEMENT_MIN_HOURS_AFTER_START) || 3);

/**
 * Keep matching strict so one completed ESPN event cannot fan out into unrelated games.
 */
const STRICT_MATCH_MAX_DELTA_MINUTES = 120;
const MAPPED_ID_MATCH_MAX_DELTA_MINUTES = 180;
const NCAAM_FUZZY_MATCH_MAX_DELTA_MINUTES = 180;
const NCAAM_FUZZY_MIN_TEAM_SIMILARITY = 0.75;
const NCAAM_FUZZY_MIN_AVG_SIMILARITY = 0.86;

function getPendingGameCoverageDiagnostics(db, cutoffUtc) {
  const totalPendingGamesRow = db
    .prepare(
      `
      SELECT COUNT(DISTINCT g.game_id) AS count
      FROM games g
      INNER JOIN card_results cr ON cr.game_id = g.game_id
      WHERE g.game_time_utc < ?
        AND cr.status = 'pending'
        AND g.game_id NOT IN (
          SELECT game_id FROM game_results WHERE status = 'final'
        )
    `,
    )
    .get(cutoffUtc);

  const displayedPendingGamesRow = db
    .prepare(
      `
      SELECT COUNT(DISTINCT g.game_id) AS count
      FROM games g
      INNER JOIN card_results cr ON cr.game_id = g.game_id
      INNER JOIN card_display_log cdl ON cdl.pick_id = cr.card_id
      WHERE g.game_time_utc < ?
        AND cr.status = 'pending'
        AND g.game_id NOT IN (
          SELECT game_id FROM game_results WHERE status = 'final'
        )
    `,
    )
    .get(cutoffUtc);

  const displayedPendingCardsRow = db
    .prepare(
      `
      SELECT COUNT(DISTINCT cr.id) AS count
      FROM games g
      INNER JOIN card_results cr ON cr.game_id = g.game_id
      INNER JOIN card_display_log cdl ON cdl.pick_id = cr.card_id
      WHERE g.game_time_utc < ?
        AND cr.status = 'pending'
        AND g.game_id NOT IN (
          SELECT game_id FROM game_results WHERE status = 'final'
        )
    `,
    )
    .get(cutoffUtc);

  return {
    totalPendingGames: Number(totalPendingGamesRow?.count || 0),
    displayedPendingGames: Number(displayedPendingGamesRow?.count || 0),
    displayedPendingCards: Number(displayedPendingCardsRow?.count || 0),
  };
}

function normalizeTeamName(name) {
  if (!name) return '';
  return String(name)
    .replace(/[^a-z0-9\s]/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toUpperCase();
}

function canonicalizeTeamToken(token) {
  let t = String(token || '')
    .trim()
    .toUpperCase();
  if (!t) return '';
  if (t === 'THE') return '';
  if (t.length === 1 && t !== 'U') return '';
  if (['ST', 'SAINT', 'STATE'].includes(t)) return 'STX';
  if (['INTL', 'INTL.', 'INT', "INTL'", 'INTERNATIONAL'].includes(t))
    return 'INTERNATIONAL';
  if (['UNIV', 'UNIVERSITY'].includes(t)) return 'UNIVERSITY';
  if (['FT', 'FORT'].includes(t)) return 'FORT';
  if (['MOUNT', 'MT'].includes(t)) return 'MOUNT';
  if (['N', 'NORTH'].includes(t)) return 'NORTH';
  if (['S', 'SOUTH'].includes(t)) return 'SOUTH';
  if (['E', 'EAST'].includes(t)) return 'EAST';
  if (['W', 'WEST'].includes(t)) return 'WEST';
  if (t.length > 4 && t.endsWith('S')) {
    t = t.slice(0, -1);
  }
  return t;
}

function teamTokenSet(name) {
  const normalized = normalizeTeamName(name);
  if (!normalized) return new Set();
  const tokens = normalized
    .split(' ')
    .map(canonicalizeTeamToken)
    .filter(Boolean);
  return new Set(tokens);
}

function tokenSimilarity(aName, bName) {
  const a = teamTokenSet(aName);
  const b = teamTokenSet(bName);
  if (a.size === 0 || b.size === 0) return 0;

  let overlap = 0;
  for (const tok of a) {
    if (b.has(tok)) overlap++;
  }

  return overlap / Math.max(a.size, b.size);
}

function toEpochMs(isoLike) {
  const ms = new Date(isoLike).getTime();
  return Number.isNaN(ms) ? null : ms;
}

function scoreMatchConfidence(deltaMinutes) {
  if (deltaMinutes <= 15) return 1.0;
  if (deltaMinutes <= 30) return 0.95;
  if (deltaMinutes <= 60) return 0.9;
  if (deltaMinutes <= 120) return 0.8;
  return 0;
}

function eventToComparable(event) {
  const comp = event.competitions?.[0];
  if (!comp || comp.status?.type?.completed !== true) return null;

  const homeComp = comp.competitors?.find((c) => c.homeAway === 'home');
  const awayComp = comp.competitors?.find((c) => c.homeAway === 'away');
  if (!homeComp || !awayComp) return null;

  const homeName = homeComp.team?.displayName || '';
  const awayName = awayComp.team?.displayName || '';
  const homeScore = Number.parseFloat(homeComp.score);
  const awayScore = Number.parseFloat(awayComp.score);
  const eventTimeMs = toEpochMs(event.date || comp.date);

  if (
    !homeName ||
    !awayName ||
    !Number.isFinite(homeScore) ||
    !Number.isFinite(awayScore) ||
    eventTimeMs === null
  ) {
    return null;
  }

  return {
    id: String(event.id),
    homeName,
    awayName,
    homeNorm: normalizeTeamName(homeName),
    awayNorm: normalizeTeamName(awayName),
    homeScore,
    awayScore,
    eventTimeMs,
  };
}

function getGameSignature(game) {
  return `${normalizeTeamName(game.home_team)}|${normalizeTeamName(game.away_team)}|${game.game_time_utc}`;
}

function findStrictNameTimeMatch(dbGame, completedEvents) {
  const gameTimeMs = toEpochMs(dbGame.game_time_utc);
  if (gameTimeMs === null) return { match: null, reason: 'invalid_game_time' };

  const homeNorm = normalizeTeamName(dbGame.home_team);
  const awayNorm = normalizeTeamName(dbGame.away_team);

  const matches = completedEvents
    .map((evt) => {
      const exactOrientation =
        evt.homeNorm === homeNorm && evt.awayNorm === awayNorm;
      const swappedOrientation =
        evt.homeNorm === awayNorm && evt.awayNorm === homeNorm;
      if (!exactOrientation && !swappedOrientation) return null;
      const deltaMinutes = Math.abs(evt.eventTimeMs - gameTimeMs) / 60000;
      if (deltaMinutes > STRICT_MATCH_MAX_DELTA_MINUTES) return null;

      const dbHomeScore = swappedOrientation ? evt.awayScore : evt.homeScore;
      const dbAwayScore = swappedOrientation ? evt.homeScore : evt.awayScore;

      return {
        event: evt,
        deltaMinutes,
        confidence: swappedOrientation
          ? Math.max(0.7, scoreMatchConfidence(deltaMinutes) - 0.05)
          : scoreMatchConfidence(deltaMinutes),
        swappedTeams: swappedOrientation,
        dbHomeScore,
        dbAwayScore,
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.deltaMinutes - b.deltaMinutes);

  if (matches.length === 0)
    return { match: null, reason: 'no_strict_candidate' };
  if (
    matches.length > 1 &&
    matches[0].deltaMinutes === matches[1].deltaMinutes
  ) {
    return { match: null, reason: 'ambiguous_tie' };
  }
  return {
    match: {
      ...matches[0],
      method: matches[0].swappedTeams
        ? 'strict_name_time_swapped'
        : 'strict_name_time',
    },
    reason: null,
  };
}

function findNcaamFuzzyNameTimeMatch(dbGame, completedEvents) {
  const gameTimeMs = toEpochMs(dbGame.game_time_utc);
  if (gameTimeMs === null) return { match: null, reason: 'invalid_game_time' };

  const matches = completedEvents
    .map((evt) => {
      const deltaMinutes = Math.abs(evt.eventTimeMs - gameTimeMs) / 60000;
      if (deltaMinutes > NCAAM_FUZZY_MATCH_MAX_DELTA_MINUTES) return null;

      const homeSimilarity = tokenSimilarity(dbGame.home_team, evt.homeName);
      const awaySimilarity = tokenSimilarity(dbGame.away_team, evt.awayName);
      const avgSimilarity = (homeSimilarity + awaySimilarity) / 2;

      if (homeSimilarity < NCAAM_FUZZY_MIN_TEAM_SIMILARITY) return null;
      if (awaySimilarity < NCAAM_FUZZY_MIN_TEAM_SIMILARITY) return null;
      if (avgSimilarity < NCAAM_FUZZY_MIN_AVG_SIMILARITY) return null;

      return {
        event: evt,
        deltaMinutes,
        confidence: Math.min(
          0.89,
          scoreMatchConfidence(deltaMinutes) * avgSimilarity,
        ),
        swappedTeams: false,
        dbHomeScore: evt.homeScore,
        dbAwayScore: evt.awayScore,
        homeSimilarity,
        awaySimilarity,
        avgSimilarity,
      };
    })
    .filter(Boolean)
    .sort((a, b) => {
      if (b.avgSimilarity !== a.avgSimilarity)
        return b.avgSimilarity - a.avgSimilarity;
      return a.deltaMinutes - b.deltaMinutes;
    });

  if (matches.length === 0)
    return { match: null, reason: 'no_ncaam_fuzzy_candidate' };

  if (
    matches.length > 1 &&
    Math.abs(matches[0].avgSimilarity - matches[1].avgSimilarity) < 0.01 &&
    Math.abs(matches[0].deltaMinutes - matches[1].deltaMinutes) < 5
  ) {
    return { match: null, reason: 'ambiguous_ncaam_fuzzy' };
  }

  return {
    match: {
      ...matches[0],
      method: 'ncaam_fuzzy_name_time',
    },
    reason: null,
  };
}

function findMatchForGame(
  dbGame,
  completedEvents,
  completedEventById,
  mappedEspnEventId,
) {
  const gameTimeMs = toEpochMs(dbGame.game_time_utc);
  if (mappedEspnEventId) {
    const mappedEvent = completedEventById.get(String(mappedEspnEventId));
    if (!mappedEvent)
      return { match: null, reason: 'mapped_event_not_completed' };

    const homeNorm = normalizeTeamName(dbGame.home_team);
    const awayNorm = normalizeTeamName(dbGame.away_team);
    const exactOrientation =
      homeNorm === mappedEvent.homeNorm && awayNorm === mappedEvent.awayNorm;
    const swappedOrientation =
      homeNorm === mappedEvent.awayNorm && awayNorm === mappedEvent.homeNorm;
    if (!exactOrientation && !swappedOrientation) {
      return { match: null, reason: 'mapped_event_team_mismatch' };
    }

    if (gameTimeMs === null)
      return { match: null, reason: 'invalid_game_time' };
    const deltaMinutes = Math.abs(mappedEvent.eventTimeMs - gameTimeMs) / 60000;
    if (deltaMinutes > MAPPED_ID_MATCH_MAX_DELTA_MINUTES) {
      return { match: null, reason: 'mapped_event_time_too_far' };
    }

    return {
      match: {
        event: mappedEvent,
        deltaMinutes,
        confidence: 1.0,
        swappedTeams: swappedOrientation,
        dbHomeScore: swappedOrientation
          ? mappedEvent.awayScore
          : mappedEvent.homeScore,
        dbAwayScore: swappedOrientation
          ? mappedEvent.homeScore
          : mappedEvent.awayScore,
        method: swappedOrientation
          ? 'mapped_event_id_swapped'
          : 'mapped_event_id',
      },
      reason: null,
    };
  }

  const strict = findStrictNameTimeMatch(dbGame, completedEvents);
  if (strict.match) return strict;

  if (String(dbGame.sport || '').toUpperCase() === 'NCAAM') {
    return findNcaamFuzzyNameTimeMatch(dbGame, completedEvents);
  }

  return strict;
}

async function fetchComparableEventFromSummary(espnClient, espnPath, eventId) {
  if (!eventId) return null;

  const summary = await espnClient.fetch(`${espnPath}/summary?event=${eventId}`);
  const competition = summary?.header?.competitions?.[0];
  if (!competition) return null;

  const pseudoEvent = {
    id: String(eventId),
    date: competition.date,
    competitions: [competition],
  };

  return eventToComparable(pseudoEvent);
}

/**
 * Main job entrypoint
 * @param {object} options - Job options
 * @param {string|null} options.jobKey - Optional deterministic window key for idempotency
 * @param {boolean} options.dryRun - If true, skip execution (log only)
 * @param {number} options.minHoursAfterStart - Minimum hours after start time before settling
 */
async function settleGameResults({
  jobKey = null,
  dryRun = false,
  minHoursAfterStart = null,
} = {}) {
  const jobRunId = `job-settle-games-${new Date().toISOString().split('.')[0]}-${uuidV4().slice(0, 8)}`;

  console.log(`[SettleGames] Starting job run: ${jobRunId}`);
  if (jobKey) {
    console.log(`[SettleGames] Job key: ${jobKey}`);
  }
  console.log(`[SettleGames] Time: ${new Date().toISOString()}`);

  // Backup database before settlement
  dbBackup.backupDatabase('before-settle-games');

  return withDb(async () => {
    // Check idempotency if jobKey provided
    if (jobKey && !shouldRunJobKey(jobKey)) {
      console.log(
        `[SettleGames] Skipping (already succeeded or running): ${jobKey}`,
      );
      return { success: true, jobRunId: null, skipped: true, jobKey };
    }

    // DRY_RUN mode (log only, no execution)
    if (dryRun) {
      console.log(
        `[SettleGames] DRY_RUN=true — would run jobKey=${jobKey || 'none'}`,
      );
      return { success: true, jobRunId: null, dryRun: true, jobKey };
    }

    let monitor;

    try {
      console.log('[SettleGames] Recording job start...');
      insertJobRun('settle_game_results', jobRunId, jobKey);

      // Initialize resilient ESPN client with env var config
      monitor = new SettlementMonitor({
        maxConsecutiveFailures: 3,
        warningThresholdPerRun: 10,
        onMetric: (msg) => console.log(msg),
        onAlert: (msg) => console.warn(msg),
        onError: (msg) => console.error(msg),
      });
      monitor.initializeRun(jobRunId);

      const espnClient = new ResilientESPNClient({
        maxRetries: SETTLEMENT_MAX_RETRIES,
        timeoutMs: ESPN_API_TIMEOUT_MS,
        baseDelayMs: 1000,
        onLog: (msg, ctx) => console.log(msg, ctx ? JSON.stringify(ctx) : ''),
        onWarn: (msg, ctx) => console.warn(msg, ctx ? JSON.stringify(ctx) : ''),
        onError: (msg, ctx) => console.error(msg, ctx ? JSON.stringify(ctx) : ''),
        monitor, // Integrate monitoring
      });

      // Initialize scoring validator
      const scoringValidator = new ScoringValidator({
        strictMode: false, // Warn but allow settlement
        onWarn: (msg, ctx) => console.warn(msg, ctx ? JSON.stringify(ctx) : ''),
      });

      console.log(
        `[SettleGames] Initialized with ESPN_API_TIMEOUT_MS=${ESPN_API_TIMEOUT_MS}ms, SETTLEMENT_MAX_RETRIES=${SETTLEMENT_MAX_RETRIES}`,
      );

      const db = getDatabase();
      const now = new Date();
      // Use environment variable if minHoursAfterStart not explicitly provided
      const safeHoursAfterStart = Number.isFinite(minHoursAfterStart)
        ? Math.max(0, minHoursAfterStart)
        : SETTLEMENT_MIN_HOURS_AFTER_START;
      // Allow faster settlement when upstream confirms status is final
      const cutoffUtc = new Date(
        now.getTime() - safeHoursAfterStart * 60 * 60 * 1000,
      ).toISOString();
      const coverageBefore = getPendingGameCoverageDiagnostics(db, cutoffUtc);
      console.log(
        `[SettleGames] Coverage before — pendingGames: ${coverageBefore.totalPendingGames}, displayedPendingGames: ${coverageBefore.displayedPendingGames}, displayedPendingCards: ${coverageBefore.displayedPendingCards}`,
      );

      // Query only games with pending cards, past cutoff, and not yet final.
      // This narrows blast radius and avoids settling schedule-only rows.
      const pendingGamesStmt = db.prepare(`
        SELECT
          g.game_id,
          g.sport,
          g.home_team,
          g.away_team,
          g.game_time_utc,
          COUNT(DISTINCT cr.id) AS pending_card_count
        FROM games g
        INNER JOIN card_results cr ON cr.game_id = g.game_id
        INNER JOIN card_display_log cdl ON cdl.pick_id = cr.card_id
        WHERE g.game_time_utc < ?
          AND cr.status = 'pending'
          AND g.game_id NOT IN (
            SELECT game_id FROM game_results WHERE status = 'final'
          )
        GROUP BY g.game_id, g.sport, g.home_team, g.away_team, g.game_time_utc
        ORDER BY g.game_time_utc ASC
      `);

      const pendingGames = pendingGamesStmt.all(cutoffUtc);
      console.log(
        `[SettleGames] Found ${pendingGames.length} unsettled past games`,
      );

      if (pendingGames.length === 0) {
        markJobRunSuccess(jobRunId);
        console.log(
          '[SettleGames] Job complete — 0 games settled (none pending)',
        );
        return {
          success: true,
          jobRunId,
          jobKey,
          gamesSettled: 0,
          sportsProcessed: [],
          errors: [],
        };
      }

      // Group games by sport for ESPN API efficiency
      const bySport = {};
      for (const game of pendingGames) {
        const sport = String(game.sport).toUpperCase();
        if (!bySport[sport]) bySport[sport] = [];
        bySport[sport].push(game);
      }

      let gamesSettled = 0;
      const sportsProcessed = [];
      const errors = [];

      for (const [sport, sportGames] of Object.entries(bySport)) {
        const espnPath = ESPN_SPORT_MAP[sport];
        if (!espnPath) {
          console.log(
            `[SettleGames] No ESPN mapping for sport: ${sport} — skipping`,
          );
          continue;
        }

        // Collect unique UTC dates from pending game times.
        // Include the next calendar day too — games starting late ET (e.g. 11 PM)
        // cross into the next UTC date, and overtime can push completion further.
        const dateSet = new Set();
        for (const g of sportGames) {
          const d = new Date(g.game_time_utc);
          const utcDate = d.toISOString().slice(0, 10).replace(/-/g, '');
          dateSet.add(utcDate);
          const nextDay = new Date(d.getTime() + 24 * 60 * 60 * 1000);
          dateSet.add(nextDay.toISOString().slice(0, 10).replace(/-/g, ''));
        }

        console.log(
          `[SettleGames] Fetching ESPN scoreboard for ${sport} — dates: ${[...dateSet].join(', ')}`,
        );

        // Fetch all dated scoreboards and merge events (dedup by ESPN event ID).
        // Without a date param ESPN returns today's scoreboard, which misses
        // yesterday's completed games when running at 02:00 ET.
        const eventMap = new Map();
        let fetchErrors = 0;
        for (const dateStr of dateSet) {
          const scoreboardEvents = await espnClient.fetchScoreboardEvents(
            espnPath,
            dateStr,
            ESPN_SCOREBOARD_OPTIONS_BY_SPORT[sport] || null,
          );

          if (!scoreboardEvents || scoreboardEvents.length === 0) {
            console.warn(
              `[SettleGames] No scoreboard data for ${sport} on ${dateStr}`,
            );
            fetchErrors++;
            continue;
          }

          for (const event of scoreboardEvents) {
            if (!eventMap.has(event.id)) {
              eventMap.set(event.id, event);
            }
          }
        }

        if (eventMap.size === 0 && fetchErrors === dateSet.size) {
          console.warn(
            `[SettleGames] All scoreboard fetches failed for ${sport}`,
          );
          errors.push(
            `${sport}: ESPN scoreboard returned no data for any date`,
          );
          continue;
        }

        const events = [...eventMap.values()];
        console.log(
          `[SettleGames] ${sport}: ${events.length} ESPN events across ${dateSet.size} date(s), ${sportGames.length} DB games to match`,
        );
        sportsProcessed.push(sport);

        // Only work with completed events with parseable teams/scores.
        let completedEvents = events.map(eventToComparable).filter(Boolean);
        const completedEventById = new Map(
          completedEvents.map((e) => [e.id, e]),
        );
        const eventUseById = new Map();

        const normalizedSport = String(sport).toLowerCase();
        const mappedRows = db
          .prepare(
            `
          SELECT game_id, external_game_id
          FROM game_id_map
          WHERE sport = ?
            AND provider = 'espn'
        `,
          )
          .all(normalizedSport);
        const mappedEspnEventIdByGameId = new Map(
          mappedRows.map((row) => [
            String(row.game_id),
            String(row.external_game_id),
          ]),
        );

        const mappedIdsToHydrate = [
          ...new Set(
            sportGames
              .map((game) =>
                mappedEspnEventIdByGameId.get(String(game.game_id)),
              )
              .filter(
                (eventId) =>
                  eventId && !completedEventById.has(String(eventId)),
              ),
          ),
        ];

        let hydratedCompletedEvents = 0;
        for (const eventId of mappedIdsToHydrate) {
          try {
            const comparable = await fetchComparableEventFromSummary(
              espnClient,
              espnPath,
              String(eventId),
            );
            if (!comparable) continue;
            if (!completedEventById.has(comparable.id)) {
              completedEventById.set(comparable.id, comparable);
              hydratedCompletedEvents++;
            }
          } catch (summaryErr) {
            console.warn(
              `[SettleGames] Failed to hydrate ESPN summary for event ${eventId}: ${summaryErr.message}`,
            );
          }
        }

        if (hydratedCompletedEvents > 0) {
          completedEvents = [...completedEventById.values()];
          console.log(
            `[SettleGames] ${sport}: hydrated ${hydratedCompletedEvents} completed event(s) from mapped ESPN IDs`,
          );
        }

        console.log(
          `[SettleGames] ${sport}: ${completedEvents.length} completed events on ESPN`,
        );

        for (const dbGame of sportGames) {
          const mappedEspnEventId =
            mappedEspnEventIdByGameId.get(String(dbGame.game_id)) ||
            (/^\d+$/.test(String(dbGame.game_id))
              ? String(dbGame.game_id)
              : null);
          const { match, reason } = findMatchForGame(
            dbGame,
            completedEvents,
            completedEventById,
            mappedEspnEventId,
          );

          if (!match) {
            console.warn(
              `[SettleGames] No safe ESPN match for ${dbGame.game_id} (${dbGame.home_team} vs ${dbGame.away_team})` +
                ` reason=${reason} mappedEspnEventId=${mappedEspnEventId || 'none'}`,
            );
            continue;
          }

          const gameSignature = getGameSignature(dbGame);
          const existingSignature = eventUseById.get(match.event.id);
          if (existingSignature && existingSignature !== gameSignature) {
            const msg = `[SettleGames] Collision: ESPN event ${match.event.id} already used for ${existingSignature}; refusing to reuse for ${gameSignature}`;
            console.warn(msg);
            errors.push(msg);
            continue;
          }
          eventUseById.set(match.event.id, gameSignature);

          // Validate scores before settlement
          const scoringCheck = scoringValidator.validateGameScore(
            sport,
            match.dbHomeScore,
            match.dbAwayScore,
          );
          const typicalCheck = scoringValidator.isTypicalScoreRange(
            sport,
            match.dbHomeScore,
            match.dbAwayScore,
          );

          console.log(
            `[SettleGames] Settling ${dbGame.game_id}: ${dbGame.home_team} ${match.dbHomeScore} - ${match.dbAwayScore} ${dbGame.away_team}` +
              ` (event=${match.event.id}, method=${match.method}, delta=${match.deltaMinutes.toFixed(1)}m)` +
              ` [scoreValid=${scoringCheck.valid}, typical=${typicalCheck.isTypical}]`,
          );

          if (scoringCheck.warnings.length > 0) {
            console.warn(
              `[SettleGames] Score validation warnings for ${dbGame.game_id}:`,
              scoringCheck.warnings,
            );
            
            // Track warnings in monitor
            scoringCheck.warnings.forEach((warning) => {
              monitor.recordScoreValidationWarning(dbGame.game_id, warning, {
                home: match.dbHomeScore,
                away: match.dbAwayScore,
              });
            });
          }

          if (dryRun) {
            console.log(
              `[SettleGames] DRY_RUN: would upsert game_result for ${dbGame.game_id}`,
            );
            gamesSettled++;
            continue;
          }

          try {
            upsertGameResult({
              id: `result-${dbGame.game_id}-${Date.now()}`,
              gameId: dbGame.game_id,
              sport: dbGame.sport,
              finalScoreHome: match.dbHomeScore,
              finalScoreAway: match.dbAwayScore,
              status: 'final',
              resultSource: 'primary_api',
              settledAt: new Date().toISOString(),
              metadata: {
                espnEventId: match.event.id,
                matchMethod: match.method,
                matchConfidence: match.confidence,
                expectedEspnEventId: mappedEspnEventId,
                timeDeltaMinutes: Number(match.deltaMinutes.toFixed(2)),
              },
            });
            gamesSettled++;
            
            // Track in monitor
            monitor.recordGameSettled(dbGame.game_id, {
              home: match.dbHomeScore,
              away: match.dbAwayScore,
            });
          } catch (gameErr) {
            console.error(
              `[SettleGames] Error upserting result for ${dbGame.game_id}: ${gameErr.message}`,
            );
            errors.push(`${dbGame.game_id}: ${gameErr.message}`);
          }
        }
      }

      markJobRunSuccess(jobRunId);
      console.log(
        `[SettleGames] Job complete — ${gamesSettled} games settled across ${sportsProcessed.join(', ') || 'no sports'}`,
      );

      if (errors.length > 0) {
        console.log(`[SettleGames] ${errors.length} errors:`);
        errors.forEach((e) => console.log(`  - ${e}`));
      }

      // Finalize monitoring
      const monitorSummary = monitor.finalizeRun(true);

      return {
        success: true,
        jobRunId,
        jobKey,
        gamesSettled,
        sportsProcessed,
        errors,
        monitoring: monitorSummary,
      };
    } catch (error) {
      if (error.code === 'JOB_RUN_ALREADY_CLAIMED') {
        console.log(
          `[RaceGuard] Skipping settle_game_results (job already claimed): ${jobKey || 'none'}`,
        );
        return { success: true, jobRunId: null, skipped: true, jobKey };
      }
      console.error(`[SettleGames] Job failed:`, error.message);
      console.error(error.stack);

      // Finalize monitoring with failure
      const monitorSummary = monitor
        ? monitor.finalizeRun(false, error.message)
        : null;

      try {
        markJobRunFailure(jobRunId, error.message);
      } catch (dbError) {
        console.error(
          `[SettleGames] Failed to record error to DB:`,
          dbError.message,
        );
      }

      return {
        success: false,
        jobRunId,
        jobKey,
        error: error.message,
        monitoring: monitorSummary,
      };
    }
  });
}

// CLI execution
if (require.main === module) {
  settleGameResults()
    .then((result) => {
      process.exit(result.success ? 0 : 1);
    })
    .catch((error) => {
      console.error('Unhandled error:', error);
      process.exit(1);
    });
}

module.exports = {
  settleGameResults,
  __private: {
    getPendingGameCoverageDiagnostics,
    normalizeTeamName,
    canonicalizeTeamToken,
    teamTokenSet,
    tokenSimilarity,
    toEpochMs,
    eventToComparable,
    findStrictNameTimeMatch,
    findNcaamFuzzyNameTimeMatch,
    findMatchForGame,
    getGameSignature,
    scoreMatchConfidence,
  },
};
