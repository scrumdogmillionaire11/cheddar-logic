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
const ESPN_API_TIMEOUT_MS = Math.max(
  5000,
  Number(process.env.ESPN_API_TIMEOUT_MS) || 30000,
);
const SETTLEMENT_MAX_RETRIES = Math.max(
  0,
  Number(process.env.SETTLEMENT_MAX_RETRIES) || 3,
);
const SETTLEMENT_MIN_HOURS_AFTER_START = Math.max(
  0,
  Number(process.env.SETTLEMENT_MIN_HOURS_AFTER_START) || 3,
);
const SETTLEMENT_ENABLE_SPORTSREF_FALLBACK =
  String(process.env.SETTLEMENT_ENABLE_SPORTSREF_FALLBACK || '').toLowerCase() ===
  'true';
const SPORTSREF_REQUEST_TIMEOUT_MS = Math.max(
  3000,
  Number(process.env.SPORTSREF_REQUEST_TIMEOUT_MS) || 15000,
);

const SPORTSREF_BASE_URL = 'https://www.sports-reference.com';

/**
 * Keep matching strict so one completed ESPN event cannot fan out into unrelated games.
 */
const STRICT_MATCH_MAX_DELTA_MINUTES = 120;
const RELAXED_EXACT_MATCH_MAX_DELTA_MINUTES = 24 * 60;
const MAPPED_ID_MATCH_MAX_DELTA_MINUTES = 180;
const NCAAM_FUZZY_MATCH_MAX_DELTA_MINUTES = 180;
const NCAAM_FUZZY_MIN_TEAM_SIMILARITY = 0.75;
const NCAAM_FUZZY_MIN_AVG_SIMILARITY = 0.86;
const SPORTSREF_FUZZY_MIN_TEAM_SIMILARITY = 0.75;
const SPORTSREF_FUZZY_MIN_AVG_SIMILARITY = 0.86;

function addUtcDays(isoLike, dayDelta) {
  const ms = toEpochMs(isoLike);
  if (ms === null) return null;
  return new Date(ms + dayDelta * 24 * 60 * 60 * 1000);
}

function normalizeWhitespace(text) {
  return String(text || '')
    .replace(/\s+/g, ' ')
    .trim();
}

function decodeHtmlEntities(text) {
  return String(text || '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

function stripHtmlTags(text) {
  return normalizeWhitespace(decodeHtmlEntities(String(text || '').replace(/<[^>]+>/g, ' ')));
}

async function fetchTextWithTimeout(url, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        Accept: 'text/html,application/xhtml+xml',
        'User-Agent': 'cheddar-logic-settlement/1.0 (+sportsref-fallback)',
      },
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    return await response.text();
  } finally {
    clearTimeout(timeout);
  }
}

function parseSportsRefMenGameSummaries(html) {
  const source = String(html || '');
  if (!source) return [];

  const summaries = [];
  const summaryRe = /<div class="game_summary[^"]*gender-m[^"]*"[\s\S]*?<\/div>/gi;
  let summaryMatch;

  while ((summaryMatch = summaryRe.exec(source)) !== null) {
    const block = summaryMatch[0];
    const rowRe = /<tr class="(winner|loser)">([\s\S]*?)<\/tr>/gi;
    const teams = [];
    let rowMatch;

    while ((rowMatch = rowRe.exec(block)) !== null) {
      const rowHtml = rowMatch[2] || '';
      const teamNameMatch = rowHtml.match(/<a href="\/cbb\/schools\/[^"]+\/men\/\d+\.html">([\s\S]*?)<\/a>/i);
      const scoreMatch = rowHtml.match(/<td class="right">\s*(\d+)\s*<\/td>/i);
      if (!teamNameMatch || !scoreMatch) continue;

      teams.push({
        name: stripHtmlTags(teamNameMatch[1]),
        score: Number.parseInt(scoreMatch[1], 10),
      });
    }

    if (teams.length !== 2) continue;

    const gameLinkMatch = block.match(/<a href="(\/cbb\/boxscores\/[^"]+\.html)">\s*F(?:<span[^>]*>inal<\/span>)?\s*<\/a>/i);

    summaries.push({
      teamAName: teams[0].name,
      teamAScore: teams[0].score,
      teamBName: teams[1].name,
      teamBScore: teams[1].score,
      boxscorePath: gameLinkMatch ? gameLinkMatch[1] : null,
    });
  }

  return summaries;
}

function toSportsRefDateKey(dateObj) {
  const year = dateObj.getUTCFullYear();
  const month = dateObj.getUTCMonth() + 1;
  const day = dateObj.getUTCDate();
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

async function fetchSportsRefMenSummariesForUtcDate(dateObj) {
  const year = dateObj.getUTCFullYear();
  const month = dateObj.getUTCMonth() + 1;
  const day = dateObj.getUTCDate();
  const url = `${SPORTSREF_BASE_URL}/cbb/boxscores/index.cgi?month=${month}&day=${day}&year=${year}`;
  const html = await fetchTextWithTimeout(url, SPORTSREF_REQUEST_TIMEOUT_MS);
  return parseSportsRefMenGameSummaries(html);
}

function candidateSportsRefDatesForGame(dbGame) {
  const base = addUtcDays(dbGame.game_time_utc, 0);
  if (!base) return [];
  const prev = addUtcDays(dbGame.game_time_utc, -1);
  const next = addUtcDays(dbGame.game_time_utc, 1);
  return [prev, base, next].filter(Boolean);
}

async function getSportsRefSummariesForGame(dbGame, cache) {
  const dateCandidates = candidateSportsRefDatesForGame(dbGame);
  const allSummaries = [];

  for (const dateObj of dateCandidates) {
    const key = toSportsRefDateKey(dateObj);
    if (!cache.has(key)) {
      try {
        const summaries = await fetchSportsRefMenSummariesForUtcDate(dateObj);
        cache.set(key, summaries);
      } catch (error) {
        cache.set(key, []);
        console.warn(
          `[SettleGames] SportsRef fetch failed for ${key}: ${error.message}`,
        );
      }
    }

    const cached = cache.get(key) || [];
    allSummaries.push(...cached);
  }

  return allSummaries;
}

function findSportsRefNcaamFuzzyMatch(dbGame, summaries) {
  const dbHome = dbGame.home_team;
  const dbAway = dbGame.away_team;

  const candidates = summaries
    .map((summary) => {
      const directHomeSimilarity = tokenSimilarity(dbHome, summary.teamAName);
      const directAwaySimilarity = tokenSimilarity(dbAway, summary.teamBName);
      const directAvg = (directHomeSimilarity + directAwaySimilarity) / 2;

      const swappedHomeSimilarity = tokenSimilarity(dbHome, summary.teamBName);
      const swappedAwaySimilarity = tokenSimilarity(dbAway, summary.teamAName);
      const swappedAvg = (swappedHomeSimilarity + swappedAwaySimilarity) / 2;

      const useSwapped = swappedAvg > directAvg;
      const homeSimilarity = useSwapped
        ? swappedHomeSimilarity
        : directHomeSimilarity;
      const awaySimilarity = useSwapped
        ? swappedAwaySimilarity
        : directAwaySimilarity;
      const avgSimilarity = useSwapped ? swappedAvg : directAvg;

      if (homeSimilarity < SPORTSREF_FUZZY_MIN_TEAM_SIMILARITY) return null;
      if (awaySimilarity < SPORTSREF_FUZZY_MIN_TEAM_SIMILARITY) return null;
      if (avgSimilarity < SPORTSREF_FUZZY_MIN_AVG_SIMILARITY) return null;

      const dbHomeScore = useSwapped ? summary.teamBScore : summary.teamAScore;
      const dbAwayScore = useSwapped ? summary.teamAScore : summary.teamBScore;

      return {
        summary,
        avgSimilarity,
        homeSimilarity,
        awaySimilarity,
        dbHomeScore,
        dbAwayScore,
        confidence: Math.min(0.84, avgSimilarity),
      };
    })
    .filter(Boolean)
    .sort((a, b) => b.avgSimilarity - a.avgSimilarity);

  if (candidates.length === 0) {
    return { match: null, reason: 'no_sportsref_fuzzy_candidate' };
  }

  if (
    candidates.length > 1 &&
    Math.abs(candidates[0].avgSimilarity - candidates[1].avgSimilarity) < 0.01
  ) {
    return { match: null, reason: 'ambiguous_sportsref_fuzzy' };
  }

  const winner = candidates[0];
  const eventId = winner.summary.boxscorePath
    ? `sportsref:${winner.summary.boxscorePath}`
    : `sportsref:${normalizeTeamName(winner.summary.teamAName)}-${normalizeTeamName(winner.summary.teamBName)}`;

  return {
    match: {
      event: {
        id: eventId,
      },
      deltaMinutes: 0,
      confidence: winner.confidence,
      swappedTeams: false,
      dbHomeScore: winner.dbHomeScore,
      dbAwayScore: winner.dbAwayScore,
      dbHomeFirstPeriodScore: null,
      dbAwayFirstPeriodScore: null,
      method: 'sportsref_ncaam_fuzzy_name_date',
      sportsRef: {
        teamAName: winner.summary.teamAName,
        teamBName: winner.summary.teamBName,
        boxscorePath: winner.summary.boxscorePath,
        homeSimilarity: Number(winner.homeSimilarity.toFixed(4)),
        awaySimilarity: Number(winner.awaySimilarity.toFixed(4)),
        avgSimilarity: Number(winner.avgSimilarity.toFixed(4)),
      },
    },
    reason: null,
  };
}

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

  const pendingCardsMissingDisplayRow = db
    .prepare(
      `
      SELECT COUNT(DISTINCT cr.id) AS count
      FROM games g
      INNER JOIN card_results cr ON cr.game_id = g.game_id
      LEFT JOIN card_display_log cdl ON cdl.pick_id = cr.card_id
      WHERE g.game_time_utc < ?
        AND cr.status = 'pending'
        AND g.game_id NOT IN (
          SELECT game_id FROM game_results WHERE status = 'final'
        )
        AND cdl.pick_id IS NULL
    `,
    )
    .get(cutoffUtc);

  const pendingGamesWithoutDisplayedCardsRow = db
    .prepare(
      `
      SELECT COUNT(*) AS count
      FROM (
        SELECT
          g.game_id,
          COUNT(DISTINCT CASE WHEN cdl.pick_id IS NOT NULL THEN cr.id END) AS displayed_pending_cards
        FROM games g
        INNER JOIN card_results cr ON cr.game_id = g.game_id
        LEFT JOIN card_display_log cdl ON cdl.pick_id = cr.card_id
        WHERE g.game_time_utc < ?
          AND cr.status = 'pending'
          AND g.game_id NOT IN (
            SELECT game_id FROM game_results WHERE status = 'final'
          )
        GROUP BY g.game_id
      ) coverage
      WHERE coverage.displayed_pending_cards = 0
    `,
    )
    .get(cutoffUtc);

  return {
    totalPendingGames: Number(totalPendingGamesRow?.count || 0),
    displayedPendingGames: Number(displayedPendingGamesRow?.count || 0),
    displayedPendingCards: Number(displayedPendingCardsRow?.count || 0),
    pendingCardsMissingDisplay: Number(
      pendingCardsMissingDisplayRow?.count || 0,
    ),
    pendingGamesWithoutDisplayedCards: Number(
      pendingGamesWithoutDisplayedCardsRow?.count || 0,
    ),
  };
}

function applyTeamAliases(text) {
  if (!text) return '';
  return String(text)
    .replace(/\bLONG\s+ISLAND\s+UNIVERSITY\b/gi, 'LIU')
    .replace(/\bGRAMBLING\s+ST\b/gi, 'GRAMBLING')
    .replace(/\bGRAMBLING\s+STATE\b/gi, 'GRAMBLING ST')
    .replace(/\bUT\s+RIO\s+GRANDE\s+VALLEY\b/gi, 'UTRGV')
    .replace(/\bN\s+COLORADO\b/gi, 'NORTHERN COLORADO')
    .replace(/\bMISS\s+VALLEY\s+STATE\b/gi, 'MISSISSIPPI VALLEY STATE')
    .replace(/\bMISS\s+VALLEY\s+ST\b/gi, 'MISSISSIPPI VALLEY STATE')
    .replace(/\bNICHOLLS\s+ST\b/gi, 'NICHOLLS')
    .replace(/\bA\s*&\s*M\s*-?\s*CC\b/gi, 'A&M CORPUS CHRISTI')
    .replace(/\bA\s+M\s+CC\b/gi, 'A&M CORPUS CHRISTI')
    .replace(/\bLA\s+SALLE\b/gi, 'LASALLE')
    .replace(/\bST\.?\s+BONAVENTURE\b/gi, 'ST BONAVENTURE')
    .replace(/\bMERCYHURST\b/gi, 'MERCYHURST LAKERS');
}

function normalizeTeamName(name) {
  if (!name) return '';
  return applyTeamAliases(String(name))
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
  if (['N', 'NORTH', 'NORTHERN'].includes(t)) return 'NORTH';
  if (['S', 'SOUTH', 'SOUTHERN'].includes(t)) return 'SOUTH';
  if (['E', 'EAST', 'EASTERN'].includes(t)) return 'EAST';
  if (['W', 'WEST', 'WESTERN'].includes(t)) return 'WEST';
  if (['MISS', 'MISS.'].includes(t)) return 'MISSISSIPPI';
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

function parseLineScoreValue(linescore) {
  if (!linescore || typeof linescore !== 'object') return null;

  const candidates = [
    linescore.value,
    linescore.score,
    linescore.displayValue,
    linescore.display_value,
  ];
  for (const candidate of candidates) {
    const parsed = Number.parseFloat(candidate);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function extractFirstPeriodScores(competition) {
  const competitors = competition?.competitors || [];
  const homeComp = competitors.find((c) => c.homeAway === 'home');
  const awayComp = competitors.find((c) => c.homeAway === 'away');
  if (!homeComp || !awayComp) return { home: null, away: null };

  const homeLineScores = Array.isArray(homeComp.linescores)
    ? homeComp.linescores
    : [];
  const awayLineScores = Array.isArray(awayComp.linescores)
    ? awayComp.linescores
    : [];

  return {
    home: parseLineScoreValue(homeLineScores[0]),
    away: parseLineScoreValue(awayLineScores[0]),
  };
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
  const firstPeriodScores = extractFirstPeriodScores(comp);

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
    homeFirstPeriodScore: firstPeriodScores.home,
    awayFirstPeriodScore: firstPeriodScores.away,
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
      const dbHomeFirstPeriodScore = swappedOrientation
        ? evt.awayFirstPeriodScore
        : evt.homeFirstPeriodScore;
      const dbAwayFirstPeriodScore = swappedOrientation
        ? evt.homeFirstPeriodScore
        : evt.awayFirstPeriodScore;

      return {
        event: evt,
        deltaMinutes,
        confidence: swappedOrientation
          ? Math.max(0.7, scoreMatchConfidence(deltaMinutes) - 0.05)
          : scoreMatchConfidence(deltaMinutes),
        swappedTeams: swappedOrientation,
        dbHomeScore,
        dbAwayScore,
        dbHomeFirstPeriodScore,
        dbAwayFirstPeriodScore,
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

function findExactNameRelaxedTimeMatch(dbGame, completedEvents) {
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
      if (deltaMinutes > RELAXED_EXACT_MATCH_MAX_DELTA_MINUTES) return null;

      const dbHomeScore = swappedOrientation ? evt.awayScore : evt.homeScore;
      const dbAwayScore = swappedOrientation ? evt.homeScore : evt.awayScore;
      const dbHomeFirstPeriodScore = swappedOrientation
        ? evt.awayFirstPeriodScore
        : evt.homeFirstPeriodScore;
      const dbAwayFirstPeriodScore = swappedOrientation
        ? evt.homeFirstPeriodScore
        : evt.awayFirstPeriodScore;

      return {
        event: evt,
        deltaMinutes,
        confidence: Math.max(0.72, scoreMatchConfidence(Math.min(deltaMinutes, 120)) - 0.08),
        swappedTeams: swappedOrientation,
        dbHomeScore,
        dbAwayScore,
        dbHomeFirstPeriodScore,
        dbAwayFirstPeriodScore,
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.deltaMinutes - b.deltaMinutes);

  if (matches.length === 0)
    return { match: null, reason: 'no_relaxed_exact_candidate' };
  if (
    matches.length > 1 &&
    Math.abs(matches[0].deltaMinutes - matches[1].deltaMinutes) < 5
  ) {
    return { match: null, reason: 'ambiguous_relaxed_exact_tie' };
  }

  return {
    match: {
      ...matches[0],
      method: matches[0].swappedTeams
        ? 'relaxed_exact_name_time_swapped'
        : 'relaxed_exact_name_time',
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
        dbHomeFirstPeriodScore: evt.homeFirstPeriodScore,
        dbAwayFirstPeriodScore: evt.awayFirstPeriodScore,
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
        dbHomeFirstPeriodScore: swappedOrientation
          ? mappedEvent.awayFirstPeriodScore
          : mappedEvent.homeFirstPeriodScore,
        dbAwayFirstPeriodScore: swappedOrientation
          ? mappedEvent.homeFirstPeriodScore
          : mappedEvent.awayFirstPeriodScore,
        method: swappedOrientation
          ? 'mapped_event_id_swapped'
          : 'mapped_event_id',
      },
      reason: null,
    };
  }

  const strict = findStrictNameTimeMatch(dbGame, completedEvents);
  if (strict.match) return strict;

  const relaxedExact = findExactNameRelaxedTimeMatch(dbGame, completedEvents);
  if (relaxedExact.match) return relaxedExact;

  if (String(dbGame.sport || '').toUpperCase() === 'NCAAM') {
    const fuzzy = findNcaamFuzzyNameTimeMatch(dbGame, completedEvents);
    if (fuzzy.match) return fuzzy;

    const reason = [strict.reason, relaxedExact.reason, fuzzy.reason]
      .filter(Boolean)
      .join(';');
    return { match: null, reason: reason || 'no_ncaam_match' };
  }

  const reason = [strict.reason, relaxedExact.reason].filter(Boolean).join(';');
  return { match: null, reason: reason || 'no_match' };
}

async function fetchComparableEventFromSummary(espnClient, espnPath, eventId) {
  if (!eventId) return null;

  const summary = await espnClient.fetch(
    `${espnPath}/summary?event=${eventId}`,
  );
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
        onError: (msg, ctx) =>
          console.error(msg, ctx ? JSON.stringify(ctx) : ''),
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
        `[SettleGames] Coverage before — pendingGames: ${coverageBefore.totalPendingGames}, displayedPendingGames: ${coverageBefore.displayedPendingGames}, displayedPendingCards: ${coverageBefore.displayedPendingCards}, pendingCardsMissingDisplay: ${coverageBefore.pendingCardsMissingDisplay}, pendingGamesWithoutDisplayedCards: ${coverageBefore.pendingGamesWithoutDisplayedCards}`,
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
          COUNT(DISTINCT cr.id) AS pending_card_count,
          COUNT(DISTINCT CASE WHEN cdl.pick_id IS NOT NULL THEN cr.id END) AS displayed_pending_card_count
        FROM games g
        INNER JOIN card_results cr ON cr.game_id = g.game_id
        LEFT JOIN card_display_log cdl ON cdl.pick_id = cr.card_id
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
      let sportsRefFallbackAttempts = 0;
      let sportsRefFallbackMatches = 0;
      let sportsRefFallbackMisses = 0;

      for (const [sport, sportGames] of Object.entries(bySport)) {
        const espnPath = ESPN_SPORT_MAP[sport];
        if (!espnPath) {
          console.log(
            `[SettleGames] No ESPN mapping for sport: ${sport} — skipping`,
          );
          continue;
        }

        // Collect unique UTC dates from pending game times.
        // Include previous/next calendar day windows to tolerate timezone/date-boundary
        // drift between scheduled start times and scoreboard index dates.
        const dateSet = new Set();
        for (const g of sportGames) {
          const d = new Date(g.game_time_utc);
          const utcDate = d.toISOString().slice(0, 10).replace(/-/g, '');
          const prevDay = new Date(d.getTime() - 24 * 60 * 60 * 1000);
          dateSet.add(utcDate);
          dateSet.add(prevDay.toISOString().slice(0, 10).replace(/-/g, ''));
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

        const sportsRefSummaryCache = new Map();

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

          let selectedMatch = match;
          let missReason = reason;

          if (
            !selectedMatch &&
            sport === 'NCAAM' &&
            SETTLEMENT_ENABLE_SPORTSREF_FALLBACK
          ) {
            sportsRefFallbackAttempts++;
            console.log(
              `[SettleGames] SportsRef fallback attempt for ${dbGame.game_id}` +
                ` (${dbGame.home_team} vs ${dbGame.away_team}) espnReason=${reason || 'none'}`,
            );
            const sportsRefSummaries = await getSportsRefSummariesForGame(
              dbGame,
              sportsRefSummaryCache,
            );
            const sportsRefResult = findSportsRefNcaamFuzzyMatch(
              dbGame,
              sportsRefSummaries,
            );
            if (sportsRefResult.match) {
              selectedMatch = sportsRefResult.match;
              sportsRefFallbackMatches++;
              console.log(
                `[SettleGames] SportsRef fallback matched ${dbGame.game_id}` +
                  ` (${dbGame.home_team} vs ${dbGame.away_team}) method=${sportsRefResult.match.method}`,
              );
            } else {
              sportsRefFallbackMisses++;
              missReason = [reason, sportsRefResult.reason]
                .filter(Boolean)
                .join(';');
              console.warn(
                `[SettleGames] SportsRef fallback no-match for ${dbGame.game_id}` +
                  ` (${dbGame.home_team} vs ${dbGame.away_team}) reason=${sportsRefResult.reason}`,
              );
            }
          }

          if (!selectedMatch) {
            console.warn(
              `[SettleGames] No safe ESPN match for ${dbGame.game_id} (${dbGame.home_team} vs ${dbGame.away_team})` +
                ` reason=${missReason} mappedEspnEventId=${mappedEspnEventId || 'none'}`,
            );
            continue;
          }

          const gameSignature = getGameSignature(dbGame);
          const existingSignature = eventUseById.get(selectedMatch.event.id);
          if (existingSignature && existingSignature !== gameSignature) {
            const msg = `[SettleGames] Collision: event ${selectedMatch.event.id} already used for ${existingSignature}; refusing to reuse for ${gameSignature}`;
            console.warn(msg);
            errors.push(msg);
            continue;
          }
          eventUseById.set(selectedMatch.event.id, gameSignature);

          // Validate scores before settlement
          const scoringCheck = scoringValidator.validateGameScore(
            sport,
            selectedMatch.dbHomeScore,
            selectedMatch.dbAwayScore,
          );
          const typicalCheck = scoringValidator.isTypicalScoreRange(
            sport,
            selectedMatch.dbHomeScore,
            selectedMatch.dbAwayScore,
          );

          console.log(
            `[SettleGames] Settling ${dbGame.game_id}: ${dbGame.home_team} ${selectedMatch.dbHomeScore} - ${selectedMatch.dbAwayScore} ${dbGame.away_team}` +
              ` (event=${selectedMatch.event.id}, method=${selectedMatch.method}, delta=${selectedMatch.deltaMinutes.toFixed(1)}m)` +
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
                home: selectedMatch.dbHomeScore,
                away: selectedMatch.dbAwayScore,
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
              finalScoreHome: selectedMatch.dbHomeScore,
              finalScoreAway: selectedMatch.dbAwayScore,
              status: 'final',
              resultSource: selectedMatch.method.startsWith('sportsref_')
                ? 'backup_scraper'
                : 'primary_api',
              settledAt: new Date().toISOString(),
              metadata: {
                espnEventId: selectedMatch.event.id,
                matchMethod: selectedMatch.method,
                matchConfidence: selectedMatch.confidence,
                expectedEspnEventId: mappedEspnEventId,
                timeDeltaMinutes: Number(selectedMatch.deltaMinutes.toFixed(2)),
                firstPeriodScores:
                  Number.isFinite(selectedMatch.dbHomeFirstPeriodScore) &&
                  Number.isFinite(selectedMatch.dbAwayFirstPeriodScore)
                    ? {
                        home: selectedMatch.dbHomeFirstPeriodScore,
                        away: selectedMatch.dbAwayFirstPeriodScore,
                      }
                    : null,
                sportsRef: selectedMatch.sportsRef || null,
              },
            });
            gamesSettled++;

            // Track in monitor
            monitor.recordGameSettled(dbGame.game_id, {
              home: selectedMatch.dbHomeScore,
              away: selectedMatch.dbAwayScore,
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
      if (SETTLEMENT_ENABLE_SPORTSREF_FALLBACK) {
        console.log(
          `[SettleGames] SportsRef fallback summary — attempts=${sportsRefFallbackAttempts}, matches=${sportsRefFallbackMatches}, misses=${sportsRefFallbackMisses}`,
        );
      }

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
