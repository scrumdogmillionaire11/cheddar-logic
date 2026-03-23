/**
 * NHL Player Shots Model Runner Job
 *
 * Reads player shot logs from DB, runs nhl-player-shots model,
 * and generates PROP card payloads for shots on goal markets.
 *
 * Exit codes:
 *   0 = success
 *   1 = failure
 */

require('dotenv').config();
const { v4: uuidV4 } = require('uuid');
const {
  getDatabase,
  insertJobRun,
  markJobRunSuccess,
  markJobRunFailure,
  setCurrentRunId,
  insertCardPayload,
  recordProjectionEntry,
  validateCardPayload,
  withDb,
  getPlayerPropLine,
} = require('@cheddar-logic/data');
const {
  calcMu,
  calcMu1p,
  classifyEdge,
  calcFairLine,
  calcFairLine1p,
  projectSogV2,
} = require('../models/nhl-player-shots');
const { fetchMoneyPuckSnapshot } = require('../moneypuck');
const {
  applyNhlDecisionBasisMeta,
  recordNhlProjectionTelemetry,
} = require('../utils/nhl-shots-patch');

const JOB_NAME = 'run-nhl-player-shots-model';

/**
 * WI-0529: Compute three-state display decision for prop cards.
 * PROJECTION_ONLY: anomaly flagged or no odds price (no actionable signal).
 * PLAY:           clean projection + positive opportunity score.
 * WATCH:          clean projection + zero or negative opportunity score.
 */
function computePropDisplayState(v2AnomalyDetected, v2OpportunityScore) {
  if (v2AnomalyDetected || v2OpportunityScore == null) return 'PROJECTION_ONLY';
  if (v2OpportunityScore > 0) return 'PLAY';
  return 'WATCH';
}

function attachRunId(card, runId) {
  if (!card) return;
  card.runId = runId;
  if (card.payloadData && typeof card.payloadData === 'object') {
    if (!card.payloadData.run_id) {
      card.payloadData.run_id = runId;
    }
  }
}

// Gap 2: Complete 32-team NHL abbreviation map.
// If a player's team_abbrev is not found here, a startup warning is logged.
const TEAM_ABBREV_TO_NAME = {
  ANA: 'Anaheim Ducks',
  BOS: 'Boston Bruins',
  BUF: 'Buffalo Sabres',
  CGY: 'Calgary Flames',
  CAR: 'Carolina Hurricanes',
  CHI: 'Chicago Blackhawks',
  COL: 'Colorado Avalanche',
  CBJ: 'Columbus Blue Jackets',
  DAL: 'Dallas Stars',
  DET: 'Detroit Red Wings',
  EDM: 'Edmonton Oilers',
  FLA: 'Florida Panthers',
  LAK: 'Los Angeles Kings',
  MIN: 'Minnesota Wild',
  MTL: 'Montreal Canadiens',
  NSH: 'Nashville Predators',
  NJD: 'New Jersey Devils',
  NYI: 'New York Islanders',
  NYR: 'New York Rangers',
  OTT: 'Ottawa Senators',
  PHI: 'Philadelphia Flyers',
  PIT: 'Pittsburgh Penguins',
  SEA: 'Seattle Kraken',
  SJS: 'San Jose Sharks',
  STL: 'St. Louis Blues',
  TBL: 'Tampa Bay Lightning',
  TOR: 'Toronto Maple Leafs',
  UTA: 'Utah Mammoth',
  VAN: 'Vancouver Canucks',
  VGK: 'Vegas Golden Knights',
  WSH: 'Washington Capitals',
  WPG: 'Winnipeg Jets',
};
const TEAM_NAME_TO_ABBREV = Object.fromEntries(
  Object.entries(TEAM_ABBREV_TO_NAME).map(([abbrev, teamName]) => [
    teamName.toUpperCase(),
    abbrev,
  ]),
);
TEAM_NAME_TO_ABBREV['UTAH HOCKEY CLUB'] = 'UTA';

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function deriveNhlSeasonId(now = new Date()) {
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth() + 1;
  const startYear = month >= 9 ? year : year - 1;
  return Number(`${startYear}${startYear + 1}`);
}

function resolveNhlSeasonKey() {
  const raw = String(
    process.env.NHL_CURRENT_SEASON ||
    process.env.NHL_SOG_SEASON_ID ||
    '',
  ).trim();
  if (/^\d{8}$/.test(raw)) {
    return raw;
  }
  return String(deriveNhlSeasonId());
}

function toFinitePositive(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return null;
  return numeric;
}

function firstPositive(...values) {
  for (const value of values) {
    const numeric = toFinitePositive(value);
    if (numeric !== null) {
      return numeric;
    }
  }
  return null;
}

function computePpMatchupFactor({
  opponentPenaltiesPer60,
  opponentPkPct,
  leagueAvgPenaltiesPer60,
  leagueAvgPkPct,
}) {
  const oppPenalties = toFinitePositive(opponentPenaltiesPer60);
  const oppPk = toFinitePositive(opponentPkPct);
  const leaguePenalties = toFinitePositive(leagueAvgPenaltiesPer60);
  const leaguePk = toFinitePositive(leagueAvgPkPct);

  if (
    oppPenalties === null ||
    oppPk === null ||
    leaguePenalties === null ||
    leaguePk === null
  ) {
    return null;
  }

  const denom = 1 - leaguePk;
  const numer = 1 - oppPk;
  if (denom <= 0 || numer <= 0) return null;

  const raw =
    (oppPenalties / leaguePenalties) *
    (numer / denom);
  if (!Number.isFinite(raw) || raw <= 0) return null;

  return clamp(raw, 0.5, 1.8);
}

function computeL5Mean(l5Sog) {
  if (!Array.isArray(l5Sog) || l5Sog.length === 0) return 0;
  return l5Sog.reduce((sum, value) => sum + value, 0) / l5Sog.length;
}

function computeL5StdDev(l5Sog, mean) {
  if (!Array.isArray(l5Sog) || l5Sog.length === 0) return 0;
  const variance =
    l5Sog.reduce((sum, value) => sum + (value - mean) ** 2, 0) / l5Sog.length;
  return Math.sqrt(variance);
}

function computeConsistencyScore(l5Sog, marketLine, direction) {
  if (!Array.isArray(l5Sog) || l5Sog.length === 0) return 0.5;

  const mean = computeL5Mean(l5Sog);
  const stdDev = computeL5StdDev(l5Sog, mean);
  const variation = mean > 0 ? stdDev / mean : 1;
  const stabilityScore = 1 - clamp(variation / 1.25, 0, 1);

  let hitRate = 0.5;
  if (typeof marketLine === 'number' && marketLine > 0) {
    const hits = l5Sog.filter((shots) =>
      direction === 'UNDER' ? shots <= marketLine : shots >= marketLine,
    ).length;
    hitRate = hits / l5Sog.length;
  }

  return clamp(hitRate * 0.7 + stabilityScore * 0.3, 0, 1);
}

function computeMatchupScore(opponentFactor, direction) {
  if (typeof opponentFactor !== 'number' || !Number.isFinite(opponentFactor)) {
    return 0.5;
  }

  const boundedOpponentFactor = clamp(opponentFactor, 0.75, 1.25);
  if (direction === 'UNDER') {
    return clamp((1.15 - boundedOpponentFactor) / 0.4, 0, 1);
  }
  return clamp((boundedOpponentFactor - 0.85) / 0.4, 0, 1);
}

function computeDecisionSupport(consistencyScore, matchupScore) {
  return clamp(consistencyScore * 0.7 + matchupScore * 0.3, 0, 1);
}

function computeConfidence(consistencyScore, matchupScore, absEdge) {
  const edgeScore = clamp(absEdge / 1.4, 0, 1);
  return clamp(
    0.45 + consistencyScore * 0.3 + matchupScore * 0.15 + edgeScore * 0.1,
    0.5,
    0.92,
  );
}

function derivePlayDecision({ edgeTier, supportScore, confidence }) {
  if (
    edgeTier === 'HOT' &&
    supportScore >= 0.62 &&
    confidence >= 0.65
  ) {
    return {
      action: 'FIRE',
      status: 'FIRE',
      classification: 'BASE',
      officialStatus: 'PLAY',
    };
  }

  if (
    (edgeTier === 'HOT' || edgeTier === 'WATCH') &&
    supportScore >= 0.5 &&
    confidence >= 0.58
  ) {
    return {
      action: 'HOLD',
      status: 'WATCH',
      classification: 'LEAN',
      officialStatus: 'LEAN',
    };
  }

  return {
    action: 'PASS',
    status: 'PASS',
    classification: 'PASS',
    officialStatus: 'PASS',
  };
}

function roundToHalfLine(value) {
  if (!Number.isFinite(value)) return null;
  return Math.round(value * 2) / 2;
}

function computeEdgePct(projection, line) {
  if (!Number.isFinite(projection) || !Number.isFinite(line) || line <= 0) {
    return null;
  }
  return Math.round(((projection - line) / line) * 1000) / 10;
}

function formatSignedEdge(edge) {
  const rounded = Math.round(edge * 10) / 10;
  return (rounded >= 0 ? '+' : '') + rounded.toFixed(1);
}

function parsePlayerIds(raw) {
  if (!raw) return [];
  const trimmed = String(raw).trim();
  if (!trimmed) return [];
  if (trimmed.startsWith('[')) {
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) {
        return parsed.map((value) => Number(value)).filter(Number.isFinite);
      }
    } catch {
      return [];
    }
  }
  return trimmed
    .split(',')
    .map((value) => Number(value.trim()))
    .filter(Number.isFinite);
}

function removeDiacritics(text) {
  if (!text || typeof text !== 'string') return '';
  return text.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

function normalizePlayerNameForLookup(name) {
  if (!name || typeof name !== 'string') return '';
  return removeDiacritics(name)
    .toLowerCase()
    .replace(/[.'\u2019-]/g, ' ')
    .replace(/\b(jr|sr|ii|iii|iv|v)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function classifyMoneyPuckInjuryEntry(entry = {}) {
  const status =
    typeof entry?.status === 'string' ? entry.status.trim().toLowerCase() : '';
  const detail =
    typeof entry?.detail === 'string' ? entry.detail.trim().toLowerCase() : '';
  const combined = `${status} ${detail}`.trim();

  if (
    combined.includes('day-to-day') ||
    combined.includes('dtd') ||
    combined.includes('questionable') ||
    combined.includes('doubtful')
  ) {
    return 'DTD';
  }

  // MoneyPuck injuries list presence is treated as unavailable by default.
  return 'INJURED';
}

function buildMoneyPuckInjuryMap(rawData = {}) {
  const map = new Map();
  const injuryStatus = rawData?.injury_status || {};
  const entries = [
    ...(Array.isArray(injuryStatus.home) ? injuryStatus.home : []),
    ...(Array.isArray(injuryStatus.away) ? injuryStatus.away : []),
  ];

  for (const entry of entries) {
    const playerName =
      typeof entry?.player === 'string' ? entry.player.trim() : null;
    if (!playerName) continue;
    const lookupKey = normalizePlayerNameForLookup(playerName);
    if (!lookupKey) continue;
    map.set(lookupKey, {
      status: classifyMoneyPuckInjuryEntry(entry),
      reason: entry?.status || entry?.detail || 'moneypuck-injury-list',
    });
  }

  return map;
}

function resolveMoneyPuckInjuriesForTeam(snapshot, teamName) {
  const injuriesByTeam = snapshot?.injuries || {};
  const direct = injuriesByTeam?.[teamName];
  if (Array.isArray(direct)) return direct;

  const normalizedTeamName =
    typeof teamName === 'string' ? teamName.trim().toLowerCase() : '';
  if (normalizedTeamName) {
    const caseInsensitiveKey = Object.keys(injuriesByTeam).find(
      (key) =>
        typeof key === 'string' && key.trim().toLowerCase() === normalizedTeamName,
    );
    if (caseInsensitiveKey && Array.isArray(injuriesByTeam[caseInsensitiveKey])) {
      return injuriesByTeam[caseInsensitiveKey];
    }
  }

  if (teamName === 'Utah Mammoth' && Array.isArray(injuriesByTeam['Utah Hockey Club'])) {
    return injuriesByTeam['Utah Hockey Club'];
  }
  if (teamName === 'Utah Hockey Club' && Array.isArray(injuriesByTeam['Utah Mammoth'])) {
    return injuriesByTeam['Utah Mammoth'];
  }

  return [];
}

function buildMoneyPuckInjuryMapForGame(snapshot, homeTeam, awayTeam) {
  return buildMoneyPuckInjuryMap({
    injury_status: {
      home: resolveMoneyPuckInjuriesForTeam(snapshot, homeTeam),
      away: resolveMoneyPuckInjuriesForTeam(snapshot, awayTeam),
    },
  });
}

function resolveTeamAbbrev(teamValue) {
  if (typeof teamValue !== 'string' || teamValue.trim().length === 0) {
    return null;
  }

  const normalized = teamValue.trim().toUpperCase();
  if (TEAM_ABBREV_TO_NAME[normalized]) {
    return normalized;
  }

  return TEAM_NAME_TO_ABBREV[normalized] || null;
}

function buildPlayerNameCandidates(playerName) {
  if (typeof playerName !== 'string') return [];
  const base = playerName.trim();
  if (!base) return [];

  const noPeriods = base.replace(/\./g, '');
  const normalizedSpacing = noPeriods.replace(/\s+/g, ' ').trim();
  const noSuffix = normalizedSpacing
    .replace(/\b(JR|SR|II|III|IV)\b$/i, '')
    .replace(/\s+/g, ' ')
    .trim();

  return [...new Set([base, normalizedSpacing, noSuffix].filter(Boolean))];
}

function resolvePlayerPropLineWithFallback({
  sport,
  gameId,
  playerName,
  propType,
  period,
}) {
  const candidates = buildPlayerNameCandidates(playerName);
  for (let index = 0; index < candidates.length; index += 1) {
    const candidateName = candidates[index];
    const resolved = getPlayerPropLine(
      sport,
      gameId,
      candidateName,
      propType,
      period,
    );
    if (resolved) {
      if (index > 0) {
        console.warn(
          `[${JOB_NAME}] Name-match fallback resolved ${period} line for '${playerName}' via '${candidateName}'`,
        );
      }
      return resolved;
    }
  }

  if (candidates.length > 1) {
    console.debug(
      `[${JOB_NAME}] No ${period} line for '${playerName}' after ${candidates.length} name candidates`,
    );
  }

  return null;
}

/**
 * Gap 6: Resolve a canonical game ID by consulting the game_id_map table first,
 * then falling back to a time+team proximity match in the games table.
 *
 * @param {string} gameId     - The game ID as stored in player_shot_logs
 * @param {string} homeTeam   - Home team full name (from games table)
 * @param {string} awayTeam   - Away team full name (from games table)
 * @param {string} gameTime   - Game time UTC (ISO string)
 * @param {object} db         - better-sqlite3 Database instance
 * @returns {string}          - Canonical game ID (or original gameId on no match)
 */
function resolveCanonicalGameId(gameId, homeTeam, awayTeam, gameTime, db) {
  try {
    // Try game_id_map first (explicit mapping)
    try {
      const mapRow = db.prepare(
        'SELECT canonical_game_id FROM game_id_map WHERE espn_game_id = ? LIMIT 1',
      ).get(gameId);
      if (mapRow && mapRow.canonical_game_id) {
        return mapRow.canonical_game_id;
      }
    } catch {
      // game_id_map may not exist — proceed to fallback
    }

    // Fallback: time + team proximity match (within 15 minutes = 0.010416 julian days)
    const proximityRow = db.prepare(`
      SELECT game_id
      FROM games
      WHERE LOWER(home_team) = LOWER(?)
        AND LOWER(away_team) = LOWER(?)
        AND ABS(julianday(game_time_utc) - julianday(?)) < 0.010416
      ORDER BY game_time_utc
      LIMIT 1
    `).get(homeTeam, awayTeam, gameTime);

    if (proximityRow && proximityRow.game_id) {
      return proximityRow.game_id;
    }
  } catch {
    // Any DB error — return original to avoid crashing the job
  }

  return gameId;
}

function purgePlayerCardsForGame({ db, gameIds, playerId, playerName }) {
  const normalizedGameIds = Array.from(
    new Set(
      (Array.isArray(gameIds) ? gameIds : [gameIds]).filter(
        (value) => typeof value === 'string' && value.trim().length > 0,
      ),
    ),
  );

  const gamePlaceholders = normalizedGameIds.map(() => '?').join(', ');
  const gameFilterClause =
    normalizedGameIds.length > 0 ? `AND game_id IN (${gamePlaceholders})` : '';

  const matchSql = `
    SELECT id
    FROM card_payloads
    WHERE LOWER(sport) = 'nhl'
      ${gameFilterClause}
      AND card_type IN ('nhl-player-shots', 'nhl-player-shots-1p')
      AND (
        CAST(json_extract(payload_data, '$.play.player_id') AS TEXT) = CAST(? AS TEXT)
        OR LOWER(COALESCE(json_extract(payload_data, '$.play.player_name'), '')) = LOWER(COALESCE(?, ''))
      )
  `;

  const matchRows = db
    .prepare(matchSql)
    .all(...normalizedGameIds, String(playerId), playerName || null);
  const cardIds = matchRows
    .map((row) => (row && typeof row.id === 'string' ? row.id : null))
    .filter((value) => Boolean(value));

  if (cardIds.length === 0) {
    return { changes: 0 };
  }

  const idPlaceholders = cardIds.map(() => '?').join(', ');
  const now = new Date().toISOString();

  db.prepare(`
    DELETE FROM card_results
    WHERE status = 'pending'
      AND card_id IN (${idPlaceholders})
  `).run(...cardIds);

  const deleted = db
    .prepare(`
      DELETE FROM card_payloads
      WHERE id IN (${idPlaceholders})
        AND id NOT IN (
          SELECT card_id
          FROM card_results
        )
    `)
    .run(...cardIds).changes;

  db.prepare(`
    UPDATE card_payloads
    SET expires_at = COALESCE(expires_at, ?), updated_at = ?
    WHERE id IN (${idPlaceholders})
      AND id IN (
        SELECT card_id
        FROM card_results
      )
      AND expires_at IS NULL
  `).run(now, now, ...cardIds);

  return { changes: deleted };
}

/**
 * Main entry point
 */
async function runNHLPlayerShotsModel() {
  return withDb(async () => {
    const jobRunId = `job-${JOB_NAME}-${new Date().toISOString().split('.')[0]}-${uuidV4().slice(0, 8)}`;
    const db = getDatabase();

    console.log(`[${JOB_NAME}] Starting job run: ${jobRunId}`);

    try {
      insertJobRun(JOB_NAME, jobRunId, null);

      // Step 1: Get active NHL games within the display window (36h from now)
      const gamesStmt = db.prepare(`
        SELECT game_id, home_team, away_team, game_time_utc, sport
        FROM games
        WHERE LOWER(sport) = 'nhl'
          AND status = 'scheduled'
          AND datetime(game_time_utc) > datetime('now')
          AND datetime(game_time_utc) < datetime('now', '+36 hours')
        ORDER BY game_time_utc ASC
      `);
      const games = gamesStmt.all();

      if (!games || games.length === 0) {
        console.log(`[${JOB_NAME}] No upcoming NHL games found`);
        markJobRunSuccess(jobRunId, { gamesProcessed: 0, cardsCreated: 0 });
        // Gap 7: setCurrentRunId called unconditionally on success path
        try {
          setCurrentRunId(jobRunId, 'nhl_props');
        } catch (runStateError) {
          console.error(
            `[${JOB_NAME}] Failed to update run state: ${runStateError.message}`,
          );
        }
        return { success: true, gamesProcessed: 0, cardsCreated: 0 };
      }

      console.log(`[${JOB_NAME}] Found ${games.length} upcoming NHL games`);

      // Step 2: Get unique players with recent data (within last 7 days)
      const uniquePlayersStmt = db.prepare(`
      SELECT DISTINCT
        player_id,
        player_name,
        json_extract(raw_data, '$.teamAbbrev') as team_abbrev
      FROM player_shot_logs
      WHERE fetched_at > datetime('now', '-7 days')
      ORDER BY player_id ASC
    `);
      const uniquePlayersRaw = uniquePlayersStmt.all();

      if (!uniquePlayersRaw || uniquePlayersRaw.length === 0) {
        console.log(
          `[${JOB_NAME}] No player shot logs found. Run 'npm run job:pull-nhl-player-shots' first.`,
        );
        markJobRunFailure(jobRunId, { error: 'No player shot logs available' });
        return { success: false, error: 'No player shot logs available' };
      }

      const uniquePlayerMap = new Map();
      for (const row of uniquePlayersRaw) {
        const existing = uniquePlayerMap.get(row.player_id);
        const existingName =
          typeof existing?.player_name === 'string' ? existing.player_name : '';
        const nextName =
          typeof row?.player_name === 'string' ? row.player_name : '';

        if (!existing || nextName.length > existingName.length) {
          uniquePlayerMap.set(row.player_id, row);
        }
      }
      const uniquePlayers = Array.from(uniquePlayerMap.values());

      console.log(
        `[${JOB_NAME}] Found ${uniquePlayers.length} deduped players with recent data`,
      );

      let moneyPuckSnapshot = null;
      try {
        moneyPuckSnapshot = await fetchMoneyPuckSnapshot({ ttlMs: 0 });
      } catch (err) {
        console.warn(`[${JOB_NAME}] MoneyPuck snapshot unavailable: ${err.message}`);
      }

      // Gap 5: 1P card generation is gated behind NHL_SOG_1P_CARDS_ENABLED env flag (default off).
      // The 1P Odds API market is unreliable — enable only when lines are consistently available.
      const sog1pEnabled = process.env.NHL_SOG_1P_CARDS_ENABLED === 'true';
      const excludedPlayerIds = new Set(
        parsePlayerIds(process.env.NHL_SOG_EXCLUDE_PLAYER_IDS),
      );
      const nhlSeasonKey = resolveNhlSeasonKey();
      if (excludedPlayerIds.size > 0) {
        console.log(
          `[${JOB_NAME}] Applying NHL_SOG_EXCLUDE_PLAYER_IDS (${excludedPlayerIds.size} players)`,
        );
      }

      // Step 4: Generate cards for each player in upcoming games
      let cardsCreated = 0;
      const timestamp = new Date().toISOString();
      const processedGamePlayers = new Set();

      for (const game of games) {
        const gameId = game.game_id;
        const homeTeam = game.home_team;
        const awayTeam = game.away_team;

        // Gap 6: Resolve canonical game ID via game_id_map / proximity match
        const resolvedGameId = resolveCanonicalGameId(gameId, homeTeam, awayTeam, game.game_time_utc, db);
        const moneyPuckInjuryMap = buildMoneyPuckInjuryMapForGame(
          moneyPuckSnapshot,
          homeTeam,
          awayTeam,
        );

        // Find players for this game (case-insensitive match against abbreviations)
        const homeTeamUpper =
          typeof homeTeam === 'string' ? homeTeam.trim().toUpperCase() : '';
        const awayTeamUpper =
          typeof awayTeam === 'string' ? awayTeam.trim().toUpperCase() : '';
        const homeTeamAbbrev = resolveTeamAbbrev(homeTeam);
        const awayTeamAbbrev = resolveTeamAbbrev(awayTeam);

        const gamePlayersMatched = uniquePlayers.filter((p) => {
          const playerTeamAbbrev =
            typeof p.team_abbrev === 'string'
              ? p.team_abbrev.toUpperCase()
              : null;
          if (!playerTeamAbbrev) {
            return false;
          }
          // Gap 2: Warn if team_abbrev is not in the map
          if (playerTeamAbbrev && !(playerTeamAbbrev in TEAM_ABBREV_TO_NAME)) {
            console.log(
              `[${JOB_NAME}] WARN: team_abbrev '${playerTeamAbbrev}' not found in TEAM_ABBREV_TO_NAME map — player ${p.player_name} may not match any game`,
            );
          }
          const playerTeamFullName = TEAM_ABBREV_TO_NAME[playerTeamAbbrev];
          const playerTeamUpper =
            typeof playerTeamFullName === 'string'
              ? playerTeamFullName.toUpperCase()
              : null;

          // Match by exact team identity only (abbreviation or canonical full name).
          // Do not use substring checks (e.g., TOR incorrectly matching "PREDATORS").
          return (
            (homeTeamAbbrev && homeTeamAbbrev === playerTeamAbbrev) ||
            (awayTeamAbbrev && awayTeamAbbrev === playerTeamAbbrev) ||
            (playerTeamUpper && playerTeamUpper === homeTeamUpper) ||
            (playerTeamUpper && playerTeamUpper === awayTeamUpper)
          );
        });

        const gamePlayers = Array.from(
          new Map(gamePlayersMatched.map((player) => [player.player_id, player])).values(),
        );

        if (gamePlayers.length === 0) {
          continue;
        }

        console.log(
          `[${JOB_NAME}] Processing ${gamePlayers.length} players for game ${resolvedGameId}`,
        );

        for (const player of gamePlayers) {
          try {
            if (excludedPlayerIds.has(Number(player.player_id))) {
              console.log(
                `[${JOB_NAME}] Skipping ${player.player_name} (${player.player_id}): excluded by NHL_SOG_EXCLUDE_PLAYER_IDS`,
              );
              continue;
            }

            const playerRunKey = `${resolvedGameId}:${player.player_id}`;
            if (processedGamePlayers.has(playerRunKey)) {
              console.log(
                `[${JOB_NAME}] Skipping duplicate player for game ${resolvedGameId}: ${player.player_name} (${player.player_id})`,
              );
              continue;
            }
            processedGamePlayers.add(playerRunKey);

            // Availability check: skip players recorded as INJURED/unavailable.
            // DTD (day-to-day/questionable) players proceed but carry a 'DTD' tier
            // flag in the card payload so downstream consumers can surface it.
            // Fail-open: if NO row exists at all (table missing or player never fetched),
            // proceed normally so new players are not permanently blocked.
            let playerAvailabilityTier = 'ACTIVE';
            const displayName =
              typeof player?.player_name === 'string' &&
              player.player_name.trim().length > 0
                ? player.player_name.trim()
                : `Player #${player.player_id}`;

            const moneyPuckInjury = moneyPuckInjuryMap.get(
              normalizePlayerNameForLookup(displayName),
            );

            try {
              const purgeGameIds = Array.from(
                new Set(
                  [resolvedGameId, gameId].filter(
                    (value) => typeof value === 'string' && value.length > 0,
                  ),
                ),
              );
              const purgeResult = purgePlayerCardsForGame({
                db,
                gameIds: purgeGameIds,
                playerId: player.player_id,
                playerName: displayName,
              });
              const purgedCount = Number(purgeResult?.changes || 0);
              if (purgedCount > 0) {
                console.log(
                  `[${JOB_NAME}] Purged ${purgedCount} existing card(s) for ${displayName} (${player.player_id}) in game ${resolvedGameId} before recalculation`,
                );
              }
            } catch (purgeErr) {
              console.warn(
                `[${JOB_NAME}] Could not purge existing cards for ${displayName} (${player.player_id}) before recalculation: ${purgeErr.message}`,
              );
            }

            try {
              const availRow = db.prepare(`
                SELECT status, status_reason, checked_at
                FROM player_availability
                WHERE player_id = ? AND sport = 'NHL'
                LIMIT 1
              `).get(player.player_id);
              if (availRow) {
                if (availRow.status === 'INJURED') {
                  try {
                    purgePlayerCardsForGame({
                      db,
                      gameIds: [],
                      playerId: player.player_id,
                      playerName: displayName,
                    });
                  } catch (purgeErr) {
                    console.warn(
                      `[${JOB_NAME}] Could not purge injured-player cards for ${displayName} (${player.player_id}): ${purgeErr.message}`,
                    );
                  }
                  console.log(
                    `[${JOB_NAME}] Skipping ${player.player_name} (${player.player_id}): availability status=INJURED${availRow.status_reason ? ` reason=${availRow.status_reason}` : ''}`,
                  );
                  continue;
                }
                if (availRow.status === 'DTD') {
                  playerAvailabilityTier = 'DTD';
                  console.log(
                    `[${JOB_NAME}] Note: ${player.player_name} (${player.player_id}) is DTD${availRow.status_reason ? ` reason=${availRow.status_reason}` : ''} — generating card with DTD tier`,
                  );
                }
              }
            } catch {
              // player_availability table may not exist in older DBs — proceed normally
            }

            if (moneyPuckInjury?.status === 'INJURED') {
              try {
                purgePlayerCardsForGame({
                  db,
                  gameIds: [],
                  playerId: player.player_id,
                  playerName: displayName,
                });
              } catch (purgeErr) {
                console.warn(
                  `[${JOB_NAME}] Could not purge MoneyPuck-injured cards for ${displayName} (${player.player_id}): ${purgeErr.message}`,
                );
              }
              console.log(
                `[${JOB_NAME}] Skipping ${displayName} (${player.player_id}): MoneyPuck injury status=${moneyPuckInjury.reason || 'listed-injured'}`,
              );
              continue;
            }

            if (moneyPuckInjury?.status === 'DTD' && playerAvailabilityTier !== 'DTD') {
              playerAvailabilityTier = 'DTD';
              console.log(
                `[${JOB_NAME}] Note: ${displayName} (${player.player_id}) is MoneyPuck DTD${moneyPuckInjury.reason ? ` reason=${moneyPuckInjury.reason}` : ''} — generating card with DTD tier`,
              );
            }

            // Get L5 games for this player (prepare fresh to avoid statement closure issues)
            const getPlayerL5Stmt = db.prepare(`
            SELECT
              game_id,
              game_date,
              opponent,
              is_home,
              shots,
              toi_minutes,
              raw_data
            FROM player_shot_logs
            WHERE player_id = ?
            ORDER BY game_date DESC
            LIMIT 5
          `);
            const l5Games = getPlayerL5Stmt.all(player.player_id);

            if (l5Games.length < 5) {
              // Task 1: Log explicit skip reason for players with insufficient recent logs
              console.log(
                `[${JOB_NAME}] Skipping ${player.player_name} (${player.player_id}): fewer than 5 recent game logs (possible injury/absence)`,
              );
              continue;
            }

            // Prefer stored player name from pull job; fallback to stable placeholder
            const hasValidName =
              typeof player.player_name === 'string' &&
              player.player_name.trim().length > 0 &&
              !player.player_name.includes('[object Object]');
            const playerName = hasValidName
              ? player.player_name.trim()
              : `Player #${player.player_id}`;

            // Build L5 SOG array (most recent first)
            const l5Sog = l5Games.map((g) => g.shots || 0);

            // Extract season stats from most recent game's raw_data if available
            let shotsPer60 = null;
            let projToi = null;
            let ppToi = 0; // WI-0528: default 0 for safe fallback on legacy log rows
            let ppRatePer60 = null; // WI-0530: season PP shot rate from NST player_pp_rates
            let ppRateL10Per60 = null; // WI-0531: L10 rolling PP shot rate
            let ppRateL5Per60 = null;  // WI-0531: L5 rolling PP shot rate
            if (l5Games[0]?.raw_data) {
              try {
                const rawData = JSON.parse(l5Games[0].raw_data);
                shotsPer60 = rawData.shotsPer60 || null;
                projToi = rawData.projToi || l5Games[0].toi_minutes || null;
                ppToi = Number.isFinite(rawData.ppToi) && rawData.ppToi > 0 ? rawData.ppToi : 0; // WI-0528: real PP TOI
                // WI-0530: treat 0 same as null — only positive rates are meaningful
                if (Number.isFinite(rawData.ppRatePer60) && rawData.ppRatePer60 > 0) {
                  ppRatePer60 = rawData.ppRatePer60;
                }
                // WI-0531: extract L10/L5 rolling rates (null if absent or non-positive)
                if (Number.isFinite(rawData.ppRateL10Per60) && rawData.ppRateL10Per60 > 0) {
                  ppRateL10Per60 = rawData.ppRateL10Per60;
                }
                if (Number.isFinite(rawData.ppRateL5Per60) && rawData.ppRateL5Per60 > 0) {
                  ppRateL5Per60 = rawData.ppRateL5Per60;
                }
              } catch {
                // Ignore parse errors
              }
            }

            const isHome =
              player.team_abbrev?.toUpperCase() === homeTeam.toUpperCase() ||
              TEAM_ABBREV_TO_NAME[player.team_abbrev?.toUpperCase()]?.toUpperCase() === homeTeam.toUpperCase();

            const playerTeamAbbrev = resolveTeamAbbrev(player.team_abbrev);
            const playerTeamName =
              (playerTeamAbbrev && TEAM_ABBREV_TO_NAME[playerTeamAbbrev]) ||
              player.team_abbrev;
            const opponentTeam = isHome ? awayTeam : homeTeam;
            const opponentAbbrev = resolveTeamAbbrev(opponentTeam);
            if (!opponentAbbrev) {
              console.debug(
                `[${JOB_NAME}] Could not resolve opponent abbreviation for '${opponentTeam}' — opponentFactor defaulting to 1.0`,
              );
            }
            const opponentTeamName =
              (opponentAbbrev && TEAM_ABBREV_TO_NAME[opponentAbbrev]) ||
              opponentTeam;

            let opponentFactor = 1.0;
            let paceFactor = 1.0;
            try {
              const factorRow = db.prepare(`
                SELECT
                  (
                    SELECT COALESCE(
                      CAST(json_extract(metrics, '$.shots_against_pg') AS REAL),
                      CAST(json_extract(metrics, '$.avgShotsAgainst') AS REAL),
                      CAST(json_extract(metrics, '$.shotsAgainstPerGame') AS REAL),
                      CAST(json_extract(metrics, '$.avgGoalsAgainst') AS REAL)
                    )
                    FROM team_metrics_cache
                    WHERE UPPER(sport) = 'NHL'
                      AND status = 'ok'
                      AND UPPER(team_name) = UPPER(?)
                    ORDER BY cache_date DESC
                    LIMIT 1
                  ) AS opponent_shots_against_pg,
                  (
                    SELECT AVG(COALESCE(
                      CAST(json_extract(metrics, '$.shots_against_pg') AS REAL),
                      CAST(json_extract(metrics, '$.avgShotsAgainst') AS REAL),
                      CAST(json_extract(metrics, '$.shotsAgainstPerGame') AS REAL),
                      CAST(json_extract(metrics, '$.avgGoalsAgainst') AS REAL)
                    ))
                    FROM team_metrics_cache
                    WHERE UPPER(sport) = 'NHL'
                      AND status = 'ok'
                      AND COALESCE(
                        CAST(json_extract(metrics, '$.shots_against_pg') AS REAL),
                        CAST(json_extract(metrics, '$.avgShotsAgainst') AS REAL),
                        CAST(json_extract(metrics, '$.shotsAgainstPerGame') AS REAL),
                        CAST(json_extract(metrics, '$.avgGoalsAgainst') AS REAL)
                      ) IS NOT NULL
                  ) AS league_avg_shots_against_pg,
                  (
                    SELECT COALESCE(
                      CAST(json_extract(metrics, '$.pace_proxy') AS REAL),
                      CAST(json_extract(metrics, '$.paceFactor') AS REAL),
                      CAST(json_extract(metrics, '$.pace') AS REAL),
                      CAST(json_extract(metrics, '$.corsi_for_pct') AS REAL) / 50.0,
                      CAST(json_extract(metrics, '$.shots_for_pg') AS REAL) /
                        NULLIF((
                          SELECT AVG(CAST(json_extract(metrics, '$.shots_for_pg') AS REAL))
                          FROM team_metrics_cache
                          WHERE UPPER(sport) = 'NHL'
                            AND status = 'ok'
                            AND json_extract(metrics, '$.shots_for_pg') IS NOT NULL
                        ), 0)
                    )
                    FROM team_metrics_cache
                    WHERE UPPER(sport) = 'NHL'
                      AND status = 'ok'
                      AND UPPER(team_name) = UPPER(?)
                    ORDER BY cache_date DESC
                    LIMIT 1
                  ) AS team_pace_proxy,
                  (
                    SELECT COALESCE(
                      CAST(json_extract(metrics, '$.pace_proxy') AS REAL),
                      CAST(json_extract(metrics, '$.paceFactor') AS REAL),
                      CAST(json_extract(metrics, '$.pace') AS REAL),
                      CAST(json_extract(metrics, '$.corsi_for_pct') AS REAL) / 50.0,
                      CAST(json_extract(metrics, '$.shots_for_pg') AS REAL) /
                        NULLIF((
                          SELECT AVG(CAST(json_extract(metrics, '$.shots_for_pg') AS REAL))
                          FROM team_metrics_cache
                          WHERE UPPER(sport) = 'NHL'
                            AND status = 'ok'
                            AND json_extract(metrics, '$.shots_for_pg') IS NOT NULL
                        ), 0)
                    )
                    FROM team_metrics_cache
                    WHERE UPPER(sport) = 'NHL'
                      AND status = 'ok'
                      AND UPPER(team_name) = UPPER(?)
                    ORDER BY cache_date DESC
                    LIMIT 1
                  ) AS opponent_pace_proxy
              `).get(opponentTeamName, playerTeamName, opponentTeamName);

              if (
                factorRow &&
                factorRow.opponent_shots_against_pg > 0 &&
                factorRow.league_avg_shots_against_pg > 0
              ) {
                opponentFactor =
                  factorRow.opponent_shots_against_pg /
                  factorRow.league_avg_shots_against_pg;
              } else {
                console.debug(
                  `[${JOB_NAME}] No usable team_metrics_cache matchup data for '${opponentTeamName}' — opponentFactor defaulting to 1.0`,
                );
              }

              const teamPaceProxy = Number(factorRow?.team_pace_proxy);
              const opponentPaceProxy = Number(factorRow?.opponent_pace_proxy);
              if (
                Number.isFinite(teamPaceProxy) &&
                teamPaceProxy > 0 &&
                Number.isFinite(opponentPaceProxy) &&
                opponentPaceProxy > 0
              ) {
                paceFactor = clamp((teamPaceProxy + opponentPaceProxy) / 2, 0.85, 1.2);
              } else {
                console.debug(
                  `[${JOB_NAME}] No usable NHL pace proxy for '${playerTeamName}' vs '${opponentTeamName}' — paceFactor defaulting to 1.0`,
                );
              }
            } catch {
              console.debug(
                `[${JOB_NAME}] Could not query team_metrics_cache for matchup factors — defaulting to opponentFactor=1.0 paceFactor=1.0`,
              );
            }

            // WI-0532: PP matchup layer from opponent PK quality + penalties against/60.
            let ppMatchupFactor = 1.0;
            let oppPkPct = null;
            let oppPenaltiesPer60 = null;
            let leagueAvgPkPct = null;
            let leagueAvgPenaltiesPer60 = null;
            let ppMatchupMissing = false;
            try {
              const opponentHomeRoad = isHome ? 'R' : 'H';
              const ppRow = db.prepare(`
                SELECT
                  (
                    SELECT pk_pct
                    FROM team_stats
                    WHERE season = ?
                      AND UPPER(team_name) = UPPER(?)
                      AND home_road = ?
                    ORDER BY updated_at DESC
                    LIMIT 1
                  ) AS opp_pk_pct_split,
                  (
                    SELECT pk_pct
                    FROM team_stats
                    WHERE season = ?
                      AND UPPER(team_name) = UPPER(?)
                      AND home_road = 'ALL'
                    ORDER BY updated_at DESC
                    LIMIT 1
                  ) AS opp_pk_pct_all,
                  (
                    SELECT penalties_against_per60
                    FROM team_stats
                    WHERE season = ?
                      AND UPPER(team_name) = UPPER(?)
                      AND home_road = ?
                    ORDER BY updated_at DESC
                    LIMIT 1
                  ) AS opp_penalties_per60_split,
                  (
                    SELECT penalties_against_per60
                    FROM team_stats
                    WHERE season = ?
                      AND UPPER(team_name) = UPPER(?)
                      AND home_road = 'ALL'
                    ORDER BY updated_at DESC
                    LIMIT 1
                  ) AS opp_penalties_per60_all,
                  (
                    SELECT AVG(pk_pct)
                    FROM team_stats
                    WHERE season = ?
                      AND home_road = ?
                      AND pk_pct IS NOT NULL
                  ) AS league_avg_pk_pct_split,
                  (
                    SELECT AVG(pk_pct)
                    FROM team_stats
                    WHERE season = ?
                      AND home_road = 'ALL'
                      AND pk_pct IS NOT NULL
                  ) AS league_avg_pk_pct_all,
                  (
                    SELECT AVG(penalties_against_per60)
                    FROM team_stats
                    WHERE season = ?
                      AND home_road = ?
                      AND penalties_against_per60 IS NOT NULL
                  ) AS league_avg_penalties_per60_split,
                  (
                    SELECT AVG(penalties_against_per60)
                    FROM team_stats
                    WHERE season = ?
                      AND home_road = 'ALL'
                      AND penalties_against_per60 IS NOT NULL
                  ) AS league_avg_penalties_per60_all
              `).get(
                nhlSeasonKey,
                opponentTeamName,
                opponentHomeRoad,
                nhlSeasonKey,
                opponentTeamName,
                nhlSeasonKey,
                opponentTeamName,
                opponentHomeRoad,
                nhlSeasonKey,
                opponentTeamName,
                nhlSeasonKey,
                opponentHomeRoad,
                nhlSeasonKey,
                nhlSeasonKey,
                opponentHomeRoad,
                nhlSeasonKey,
              );

              oppPkPct = firstPositive(
                ppRow?.opp_pk_pct_split,
                ppRow?.opp_pk_pct_all,
              );
              oppPenaltiesPer60 = firstPositive(
                ppRow?.opp_penalties_per60_split,
                ppRow?.opp_penalties_per60_all,
              );
              leagueAvgPkPct = firstPositive(
                ppRow?.league_avg_pk_pct_split,
                ppRow?.league_avg_pk_pct_all,
              );
              leagueAvgPenaltiesPer60 = firstPositive(
                ppRow?.league_avg_penalties_per60_split,
                ppRow?.league_avg_penalties_per60_all,
              );

              const computedPpMatchupFactor = computePpMatchupFactor({
                opponentPenaltiesPer60: oppPenaltiesPer60,
                opponentPkPct: oppPkPct,
                leagueAvgPenaltiesPer60,
                leagueAvgPkPct,
              });
              if (computedPpMatchupFactor !== null) {
                ppMatchupFactor = computedPpMatchupFactor;
              } else if (ppToi > 0) {
                ppMatchupMissing = true;
                console.debug(
                  `[${JOB_NAME}] Missing PP matchup inputs for '${opponentTeamName}' season=${nhlSeasonKey} — pp_matchup_factor defaulting to 1.0`,
                );
              }
            } catch {
              if (ppToi > 0) {
                ppMatchupMissing = true;
              }
              console.debug(
                `[${JOB_NAME}] Could not query team_stats for PP matchup factor — defaulting to 1.0`,
              );
            }

            // Run model for full game
            const mu = calcMu({
              l5Sog,
              shotsPer60: shotsPer60,
              projToi: projToi,
              opponentFactor,
              paceFactor,
              isHome,
            });

            // Run model for 1st period
            const mu1p = calcMu1p({
              l5Sog,
              shotsPer60: shotsPer60,
              projToi: projToi,
              opponentFactor,
              paceFactor,
              isHome,
            });

            // Fetch real market lines from DB (populated by pull_nhl_player_shots_props job).
            // When no real line exists, use a configurable projection floor (default 2.5 SOG) so
            // projection-mode cards are still generated for the best shooters. A player at 3.3 mu
            // vs a 2.5 floor = 0.8 edge = HOT. Set NHL_SOG_PROJECTION_LINE to adjust the threshold.
            const realPropLine = resolvePlayerPropLineWithFallback({
              sport: 'NHL',
              gameId: resolvedGameId,
              playerName,
              propType: 'shots_on_goal',
              period: 'full_game',
            });
            let marketLine;
            if (realPropLine) {
              marketLine = realPropLine.line;
            } else {
              marketLine = parseFloat(process.env.NHL_SOG_PROJECTION_LINE || '2.5');
              console.log(`[projection-mode] line=${marketLine} (no real Odds API line — using projection floor)`);
            }
            const usingRealLine = !!realPropLine;

            // --- V2 Price Integration ---
            // Extract prices already stored by pull_nhl_player_shots_props.
            // getPlayerPropLine SELECTs over_price/under_price but the caller
            // previously only read .line — now we read the prices too.
            const overPrice = realPropLine?.over_price ?? null;
            const underPrice = realPropLine?.under_price ?? null;
            const isOddsBacked = overPrice !== null && underPrice !== null;

            // Derive a trending L5 rate for projectSogV2's weighted blend.
            // l5RatePer60: L5 mean shots / projected TOI * 60 (per-60 normalised).
            const l5Mean = computeL5Mean(l5Sog);
            const l5RatePer60 =
              projToi && projToi > 0
                ? (l5Mean / projToi) * 60
                : shotsPer60 ?? null;

            const v2Projection = projectSogV2({
              player_id: player.player_id,
              game_id: resolvedGameId,
              ev_shots_season_per60: shotsPer60 ?? null,
              // L10 is not stored separately; use L5-derived rate as a proxy
              // rather than copying shotsPer60 (which is a season average, not L10).
              // This avoids a false LOW_SAMPLE flag while being directionally correct.
              ev_shots_l10_per60: l5RatePer60 ?? shotsPer60 ?? null,
              ev_shots_l5_per60: l5RatePer60,
              pp_shots_season_per60: ppRatePer60,   // WI-0530: NST season rate (null if missing)
              pp_shots_l10_per60: ppRateL10Per60,   // WI-0531: real L10 rolling rate (null if absent)
              pp_shots_l5_per60: ppRateL5Per60,     // WI-0531: real L5 rolling rate (null if absent)
              toi_proj_ev: projToi ?? 0,
              toi_proj_pp: ppToi, // WI-0528: real PP TOI from featuredStats.subSeason.avgPpToi (0 fallback for non-PP players)
              pp_matchup_factor: ppMatchupFactor,
              shot_env_factor: paceFactor,
              opponent_suppression_factor: opponentFactor,
              role_stability: playerAvailabilityTier === 'DTD' ? 'MEDIUM' : 'HIGH',
              market_line: marketLine,
              market_price_over: overPrice,
              market_price_under: underPrice,
              // WI-0575: derive play direction so opportunity_score uses correct side.
              // classifyEdge is deterministic; this matches fullGameEdge.direction computed later.
              play_direction: classifyEdge(mu, marketLine, 0.75).direction,
            });

            if (!isOddsBacked) {
              console.log(
                `[${JOB_NAME}] [projection-mode] No prices for ${playerName} — MISSING_PRICE flag, opportunity_score=null`,
              );
            }

            // WI-0530: PP_RATE_MISSING flag — player has PP TOI but no NST rate was available.
            // Non-PP players (ppToi=0) do NOT get flagged — the rate is simply irrelevant for them.
            if (ppRatePer60 === null && ppToi > 0) {
              v2Projection.flags.push('PP_RATE_MISSING');
            }

            // WI-0531: PP_SMALL_SAMPLE — player is on PP (has season rate) but fewer than 5 games
            // of rolling data (both L10 and L5 null). Single null does NOT trigger the flag.
            if (ppRatePer60 !== null && ppRateL10Per60 === null && ppRateL5Per60 === null) {
              v2Projection.flags.push('PP_SMALL_SAMPLE');
            }

            if (ppMatchupMissing) {
              v2Projection.flags.push('PP_MATCHUP_MISSING');
            }

            // WI-0531: Compute the actual PP blend rate for drivers display.
            // Mirrors weightedRateBlendPP logic (0.40/0.35/0.25) so drivers is consistent with model.
            const ppBlendRate = (() => {
              const vals = [ppRatePer60, ppRateL10Per60, ppRateL5Per60];
              const wts = [0.40, 0.35, 0.25];
              const present = vals.map((v, i) => (v !== null ? { v, w: wts[i] } : null)).filter(Boolean);
              if (present.length === 0) return null;
              const totalW = present.reduce((s, x) => s + x.w, 0);
              return present.reduce((s, x) => s + (x.v * x.w) / totalW, 0);
            })();

            // V2 anomaly: sog_mu collapsing far below L5 average signals model breakdown.
            // This is separate from projectionAnomalyDetected (V1 path) and gates V2 pricing only.
            const v2AnomalyDetected = v2Projection.sog_mu < 0.6 * l5Mean;

            // Null out pricing fields when V2 anomaly is present — no bet-worthy signal should be emitted.
            const v2EdgeOverPp = v2AnomalyDetected ? null : (v2Projection.edge_over_pp != null ? Math.round(v2Projection.edge_over_pp * 10000) / 10000 : null);
            const v2EvOver = v2AnomalyDetected ? null : (v2Projection.ev_over != null ? Math.round(v2Projection.ev_over * 10000) / 10000 : null);
            const v2OpportunityScore = v2AnomalyDetected ? null : (v2Projection.opportunity_score ?? null);

            const syntheticLine = marketLine; // kept for card payload references below

            // 1P: also use projection floor when no real line (scaled from full-game floor by 1P share)
            const realPropLine1p = resolvePlayerPropLineWithFallback({
              sport: 'NHL',
              gameId: resolvedGameId,
              playerName,
              propType: 'shots_on_goal',
              period: 'first_period',
            });
            const overPrice1p = realPropLine1p?.over_price ?? null;
            const underPrice1p = realPropLine1p?.under_price ?? null;
            let syntheticLine1p;
            if (realPropLine1p) {
              syntheticLine1p = realPropLine1p.line;
            } else {
              const floorFull = parseFloat(process.env.NHL_SOG_PROJECTION_LINE || '2.5');
              syntheticLine1p = Math.round(floorFull * 0.32 * 2) / 2;
              if (sog1pEnabled) {
                console.log(`[projection-mode] 1P line=${syntheticLine1p} (no real Odds API line — using projection floor)`);
              }
            }

            if (!usingRealLine) {
              console.warn(`[${JOB_NAME}] No real prop line for ${playerName} game ${resolvedGameId} — using synthetic fallback`);
            }

            // Fair line: L5 consistency baseline (no matchup adjustments).
            // This is what the market typically prices the player at.
            const l5FairValue = calcFairLine({ l5Sog, shotsPer60, projToi });
            const fairLine = roundToHalfLine(l5FairValue) ?? syntheticLine;

            // Matchup edge: how much the projection departs from the L5 baseline.
            // Positive = matchup-positive (tough defense hurt opponents, home ice, etc.).
            const matchupEdge = Math.round((mu - l5FairValue) * 10) / 10;

            const fullDirectionSeed = classifyEdge(mu, syntheticLine, 0.75);
            const fullConsistencyScore = computeConsistencyScore(
              l5Sog,
              syntheticLine,
              fullDirectionSeed.direction,
            );
            const fullMatchupScore = computeMatchupScore(
              opponentFactor,
              fullDirectionSeed.direction,
            );
            const fullSupportScore = computeDecisionSupport(
              fullConsistencyScore,
              fullMatchupScore,
            );
            const confidence = computeConfidence(
              fullConsistencyScore,
              fullMatchupScore,
              Math.abs(mu - syntheticLine),
            );

            // Projection anomaly guard: when recency-weighted mu is <60% of the
            // arithmetic L5 mean, the model is collapsing due to recent low-shot
            // games. In this case we must never emit FIRE — the "huge UNDER edge"
            // against a synthetic floor line is not a real signal.
            const projectionAnomalyDetected = mu < 0.6 * l5Mean;
            if (projectionAnomalyDetected) {
              console.warn(
                `[${JOB_NAME}] PROJECTION_ANOMALY: ${playerName} weighted_mu=${mu.toFixed(2)} < 0.6 * l5_arith_mean=${l5Mean.toFixed(2)} — FIRE will be blocked. Check recent shot log; likely had 0–1 shots in last 2 games.`,
              );
            }

            // Structured debug log — every player gets one line for diagnostics.
            console.log(
              `[${JOB_NAME}] [debug] ${playerName}: l5=${JSON.stringify(l5Sog)} l5_arith=${l5Mean.toFixed(2)} mu=${mu.toFixed(3)} line=${syntheticLine} real_line=${usingRealLine} projToi=${projToi ?? 'null'} shotsPer60=${shotsPer60 ?? 'null'} oppF=${opponentFactor.toFixed(3)} paceF=${paceFactor.toFixed(3)} ppMatch=${ppMatchupFactor.toFixed(3)} isHome=${isHome} anomaly=${projectionAnomalyDetected}`,
            );

            // Classify edges after confidence is derived from consistency + matchup.
            const fullGameEdge = classifyEdge(mu, syntheticLine, confidence);
            let fullDecision = derivePlayDecision({
              edgeTier: fullGameEdge.tier,
              supportScore: fullSupportScore,
              confidence,
            });

            // Guard 1: Never FIRE on projection-only cards (no real Odds API line).
            // A synthetic floor line creates fake edge even when the player projects
            // legitimately. Real odds are required to validate a bet-worthy signal.
            if (!usingRealLine && fullDecision.action === 'FIRE') {
              console.warn(
                `[${JOB_NAME}] [no-real-line] Downgraded ${playerName} FIRE→WATCH (projection-mode card — no real Odds API line)`,
              );
              fullDecision = {
                action: 'HOLD',
                status: 'WATCH',
                classification: 'LEAN',
                officialStatus: 'LEAN',
              };
            }

            // Guard 2: Never FIRE when weighted projection has collapsed below 60%
            // of the arithmetic L5 mean. This catches the aggressive-recency-decay
            // scenario where 0-shot games dominate the weighted average.
            if (projectionAnomalyDetected && fullDecision.action === 'FIRE') {
              console.warn(
                `[${JOB_NAME}] [anomaly-guard] Downgraded ${playerName} FIRE→WATCH (PROJECTION_ANOMALY)`,
              );
              fullDecision = {
                action: 'HOLD',
                status: 'WATCH',
                classification: 'LEAN',
                officialStatus: 'LEAN',
              };
            }

            const fullDirectionLabel =
              fullGameEdge.direction === 'OVER' ? 'Over' : 'Under';
            const fullRecommendationPrefix =
              fullDecision.action === 'FIRE'
                ? 'Play'
                : fullDecision.action === 'HOLD'
                  ? 'Lean'
                  : 'Pass';

            // Only create cards for actionable signals.
            if (
              (fullGameEdge.tier === 'HOT' || fullGameEdge.tier === 'WATCH') &&
              fullDecision.action !== 'PASS'
            ) {
              const cardId = `nhl-player-sog-${player.player_id}-${resolvedGameId}-full-${uuidV4().slice(0, 8)}`;

              // For PROP cards, don't set market_type to 'PROP' in the root; keep it implied
              // and let the data layer treat it as a PROP without trying to lock it via deriveLockedMarketContext
              const payloadData = {
                sport: 'NHL',
                home_team: homeTeam,
                away_team: awayTeam,
                game_time_utc: game.game_time_utc,
                card_type: 'nhl-player-shots',
                tier: fullGameEdge.tier,
                availability_tier: playerAvailabilityTier,
                card_status: 'active',
                model_name: 'nhl-player-shots-v1',
                model_version: '1.0.0',
                action: fullDecision.action,
                status: fullDecision.status,
                classification: fullDecision.classification,
                // Required by basePayloadSchema
                prediction: `${fullRecommendationPrefix} ${playerName} ${fullDirectionLabel} ${syntheticLine} SOG | Proj ${mu.toFixed(1)} · Fair ${fairLine} · Edge ${formatSignedEdge(matchupEdge)}`,
                confidence: confidence,
                recommended_bet_type: 'unknown',
                generated_at: timestamp,
                suggested_line: fairLine,
                threshold: fairLine,
                decision_v2: {
                  official_status: fullDecision.officialStatus,
                  direction: fullGameEdge.direction,
                  edge_pct: computeEdgePct(mu, syntheticLine),
                  fair_line: fairLine,
                },
                // PROP-specific
                play: {
                  action: fullDecision.action,
                  status: fullDecision.status,
                  classification: fullDecision.classification,
                  decision_v2: {
                    official_status: fullDecision.officialStatus,
                    direction: fullGameEdge.direction,
                    edge_pct: computeEdgePct(mu, syntheticLine),
                    fair_line: fairLine,
                  },
                  pick_string: `${fullRecommendationPrefix} ${playerName} ${fullDirectionLabel} ${syntheticLine} SOG | Proj ${mu.toFixed(1)} · Fair ${fairLine} · Edge ${formatSignedEdge(matchupEdge)}`,
                  market_type: 'PROP',
                  player_name: playerName,
                  player_id: player.player_id.toString(),
                  prop_type: 'shots_on_goal',
                  period: 'full_game',
                  selection: {
                    side: fullGameEdge.direction === 'OVER' ? 'over' : 'under',
                    line: syntheticLine,
                    price: fullGameEdge.direction === 'OVER' ? (overPrice ?? -110) : (underPrice ?? -110),
                    team: player.team_abbrev,
                    player_name: playerName,
                    player_id: player.player_id.toString(),
                  },
                },
                odds_backed: isOddsBacked,
                over_price: isOddsBacked ? overPrice : null,
                under_price: isOddsBacked ? underPrice : null,
                opportunity_score: v2OpportunityScore,
                prop_display_state: computePropDisplayState(v2AnomalyDetected, v2OpportunityScore),
                decision: {
                  edge_pct: computeEdgePct(mu, syntheticLine),
                  projection: Math.round(mu * 100) / 100,
                  fair_line: fairLine,
                  matchup_edge: matchupEdge,
                  model_projection: mu,
                  market_line: syntheticLine,
                  direction: fullGameEdge.direction,
                  confidence: confidence,
                  market_line_source: usingRealLine ? 'odds_api' : 'synthetic_fallback',
                  consistency_score:
                    Math.round(fullConsistencyScore * 1000) / 1000,
                  matchup_score: Math.round(fullMatchupScore * 1000) / 1000,
                  support_score: Math.round(fullSupportScore * 1000) / 1000,
                  opportunity_score: v2OpportunityScore,
                  v2: {
                    sog_mu: v2Projection.sog_mu != null ? Math.round(v2Projection.sog_mu * 1000) / 1000 : null,
                    edge_over_pp: v2EdgeOverPp,
                    ev_over: v2EvOver,
                    opportunity_score: v2OpportunityScore,
                    flags: [
                      ...(v2Projection.flags ?? []),
                      ...(v2AnomalyDetected ? ['PROJECTION_ANOMALY'] : []),
                      ...(!usingRealLine ? ['SYNTHETIC_LINE'] : []),
                    ],
                    odds_backed: isOddsBacked,
                  },
                },
                drivers: {
                  l5_avg: l5Sog.reduce((a, b) => a + b, 0) / 5,
                  l5_fair_value: Math.round(l5FairValue * 100) / 100,
                  l5_sog: l5Sog,
                  shots_per_60: shotsPer60,
                  proj_toi: projToi,
                  is_home: isHome,
                  opponent_factor: opponentFactor,
                  pace_factor: paceFactor,
                  pp_matchup_factor:
                    v2Projection.pp_matchup_factor != null
                      ? Math.round(v2Projection.pp_matchup_factor * 1000) / 1000
                      : Math.round(ppMatchupFactor * 1000) / 1000,
                  opp_pk_pct: oppPkPct != null ? Math.round(oppPkPct * 1000) / 1000 : null,
                  opp_penalties_per60:
                    oppPenaltiesPer60 != null
                      ? Math.round(oppPenaltiesPer60 * 1000) / 1000
                      : null,
                  consistency_score:
                    Math.round(fullConsistencyScore * 1000) / 1000,
                  matchup_score: Math.round(fullMatchupScore * 1000) / 1000,
                  // Projection model inputs surfaced for debugging and audit
                  sog_mu: v2Projection.sog_mu != null ? Math.round(v2Projection.sog_mu * 1000) / 1000 : null,
                  toi_proj_ev: v2Projection.toi_proj != null ? v2Projection.toi_proj : (projToi ?? null),
                  ev_rate: v2Projection.shot_rate_ev_per60 != null ? Math.round(v2Projection.shot_rate_ev_per60 * 100) / 100 : null,
                  pp_rate: v2Projection.shot_rate_pp_per60 != null ? Math.round(v2Projection.shot_rate_pp_per60 * 100) / 100 : null,
                  pp_rate_per60: ppRatePer60,   // WI-0530: raw NST season rate before blend
                  pp_season_rate: ppRatePer60,  // WI-0531: alias for clarity
                  pp_l10_rate: ppRateL10Per60,  // WI-0531: L10 rolling rate (null if absent)
                  pp_l5_rate: ppRateL5Per60,    // WI-0531: L5 rolling rate (null if absent)
                  pp_blend_rate: ppBlendRate !== null ? Math.round(ppBlendRate * 100) / 100 : null, // WI-0531
                  shot_env_factor: v2Projection.shot_env_factor != null ? Math.round(v2Projection.shot_env_factor * 1000) / 1000 : null,
                  trend_factor: v2Projection.trend_score != null ? Math.round(v2Projection.trend_score * 1000) / 1000 : null,
                  v2_anomaly: v2AnomalyDetected,
                },
              };

              const edgePct = computeEdgePct(mu, syntheticLine);
              applyNhlDecisionBasisMeta(payloadData, {
                usingRealLine,
                edgePct,
              });
              if (!usingRealLine && payloadData.decision_basis_meta) {
                payloadData.decision_basis_meta.market_line_source = 'synthetic_fallback';
              }

              const card = {
                id: cardId,
                gameId: resolvedGameId,
                sport: 'NHL',
                cardType: 'nhl-player-shots',
                cardTitle: `${playerName} Shots on Goal`,
                createdAt: timestamp,
                payloadData: payloadData,
              };
              attachRunId(card, jobRunId);

              try {
                insertCardPayload(card);
                try {
                  recordNhlProjectionTelemetry(recordProjectionEntry, card);
                } catch (telemetryErr) {
                  console.warn(
                    `[${JOB_NAME}] Projection telemetry skipped for ${card.id}: ${telemetryErr.message}`,
                  );
                }
                cardsCreated++;
                console.log(
                  `[${JOB_NAME}] ✓ Created ${fullGameEdge.tier} card: ${playerName} ${fullGameEdge.direction} ${syntheticLine} (fair ${fairLine}, conf ${Math.round(confidence * 100)}%)`,
                );
              } catch (insertErr) {
                console.error(
                  `[${JOB_NAME}] Failed to insert card: ${insertErr.message}`,
                );
              }
            } else if (fullDecision.action === 'PASS') {
              console.log(
                `[${JOB_NAME}] Skipping ${playerName} ${fullGameEdge.direction} ${syntheticLine}: PASS (consistency=${fullConsistencyScore.toFixed(2)}, matchup=${fullMatchupScore.toFixed(2)})`,
              );
            }

            // Gap 5: 1P card block gated by NHL_SOG_1P_CARDS_ENABLED flag (default off).
            // The 1P Odds API market (player_shots_on_goal_1p) is unreliable — lines
            // are rarely available, so 1P cards almost always use synthetic fallback.
            // Enable via NHL_SOG_1P_CARDS_ENABLED=true only after confirming line availability.
            if (sog1pEnabled) {
              const l5Sog1p = l5Sog.map((shots) =>
                Math.round(shots * 0.32 * 10) / 10,
              );
              const firstPeriodDirectionSeed = classifyEdge(
                mu1p,
                syntheticLine1p,
                0.75,
              );
              const firstPeriodConsistencyScore = computeConsistencyScore(
                l5Sog1p,
                syntheticLine1p,
                firstPeriodDirectionSeed.direction,
              );
              const firstPeriodMatchupScore = computeMatchupScore(
                opponentFactor,
                firstPeriodDirectionSeed.direction,
              );
              const firstPeriodSupportScore = computeDecisionSupport(
                firstPeriodConsistencyScore,
                firstPeriodMatchupScore,
              );
              const firstPeriodConfidence = computeConfidence(
                firstPeriodConsistencyScore,
                firstPeriodMatchupScore,
                Math.abs(mu1p - syntheticLine1p),
              );
              const firstPeriodEdge = classifyEdge(
                mu1p,
                syntheticLine1p,
                firstPeriodConfidence,
              );
              let firstPeriodDecision = derivePlayDecision({
                edgeTier: firstPeriodEdge.tier,
                supportScore: firstPeriodSupportScore,
                confidence: firstPeriodConfidence,
              });

              // Apply same guards as full-game path.
              if (!realPropLine1p && firstPeriodDecision.action === 'FIRE') {
                firstPeriodDecision = { action: 'HOLD', status: 'WATCH', classification: 'LEAN', officialStatus: 'LEAN' };
              }
              if (projectionAnomalyDetected && firstPeriodDecision.action === 'FIRE') {
                firstPeriodDecision = { action: 'HOLD', status: 'WATCH', classification: 'LEAN', officialStatus: 'LEAN' };
              }

              const l5FairValue1p = calcFairLine1p({ l5Sog, shotsPer60, projToi });
              const fairLine1p = roundToHalfLine(l5FairValue1p) ?? syntheticLine1p;
              const matchupEdge1p = Math.round((mu1p - l5FairValue1p) * 10) / 10;
              const firstPeriodDirectionLabel =
                firstPeriodEdge.direction === 'OVER' ? 'Over' : 'Under';
              const firstPeriodRecommendationPrefix =
                firstPeriodDecision.action === 'FIRE'
                  ? 'Play'
                  : firstPeriodDecision.action === 'HOLD'
                    ? 'Lean'
                    : 'Pass';

              if (
                (firstPeriodEdge.tier === 'HOT' ||
                  firstPeriodEdge.tier === 'WATCH') &&
                firstPeriodDecision.action !== 'PASS'
              ) {
                const cardId1p = `nhl-player-sog-${player.player_id}-${resolvedGameId}-1p-${uuidV4().slice(0, 8)}`;

                const payloadData1p = {
                  sport: 'NHL',
                  home_team: homeTeam,
                  away_team: awayTeam,
                  game_time_utc: game.game_time_utc,
                  card_type: 'nhl-player-shots-1p',
                  tier: firstPeriodEdge.tier,
                  availability_tier: playerAvailabilityTier,
                  card_status: 'active',
                  model_name: 'nhl-player-shots-v1',
                  model_version: '1.0.0',
                  action: firstPeriodDecision.action,
                  status: firstPeriodDecision.status,
                  classification: firstPeriodDecision.classification,
                  // Required by basePayloadSchema
                  prediction: `${firstPeriodRecommendationPrefix} ${playerName} ${firstPeriodDirectionLabel} ${syntheticLine1p} SOG (1P) | Proj ${mu1p.toFixed(1)} · Fair ${fairLine1p} · Edge ${formatSignedEdge(matchupEdge1p)}`,
                  confidence: firstPeriodConfidence,
                  recommended_bet_type: 'unknown',
                  generated_at: timestamp,
                  suggested_line: fairLine1p,
                  threshold: fairLine1p,
                  decision_v2: {
                    official_status: firstPeriodDecision.officialStatus,
                    direction: firstPeriodEdge.direction,
                    edge_pct: computeEdgePct(mu1p, syntheticLine1p),
                    fair_line: fairLine1p,
                  },
                  // PROP-specific
                  play: {
                    action: firstPeriodDecision.action,
                    status: firstPeriodDecision.status,
                    classification: firstPeriodDecision.classification,
                    decision_v2: {
                      official_status: firstPeriodDecision.officialStatus,
                      direction: firstPeriodEdge.direction,
                      edge_pct: computeEdgePct(mu1p, syntheticLine1p),
                      fair_line: fairLine1p,
                    },
                    pick_string: `${firstPeriodRecommendationPrefix} ${playerName} ${firstPeriodDirectionLabel} ${syntheticLine1p} SOG (1P) | Proj ${mu1p.toFixed(1)} · Fair ${fairLine1p} · Edge ${formatSignedEdge(matchupEdge1p)}`,
                    market_type: 'PROP',
                    player_name: playerName,
                    player_id: player.player_id.toString(),
                    prop_type: 'shots_on_goal',
                    period: 'first_period',
                    selection: {
                      side:
                        firstPeriodEdge.direction === 'OVER' ? 'over' : 'under',
                      line: syntheticLine1p,
                      price: firstPeriodEdge.direction === 'OVER' ? (overPrice1p ?? -110) : (underPrice1p ?? -110),
                      team: player.team_abbrev,
                      player_name: playerName,
                      player_id: player.player_id.toString(),
                    },
                  },
                  decision: {
                    projection: Math.round(mu1p * 100) / 100,
                    fair_line: fairLine1p,
                    matchup_edge: matchupEdge1p,
                    edge_pct: computeEdgePct(mu1p, syntheticLine1p),
                    model_projection: mu1p,
                    market_line: syntheticLine1p,
                    direction: firstPeriodEdge.direction,
                    confidence: firstPeriodConfidence,
                    market_line_source: realPropLine1p ? 'odds_api' : 'synthetic_fallback',
                    consistency_score:
                      Math.round(firstPeriodConsistencyScore * 1000) / 1000,
                    matchup_score:
                      Math.round(firstPeriodMatchupScore * 1000) / 1000,
                    support_score:
                      Math.round(firstPeriodSupportScore * 1000) / 1000,
                  },
                  drivers: {
                    l5_avg_1p: (l5Sog.reduce((a, b) => a + b, 0) / 5) * 0.32,
                    l5_fair_value_1p: Math.round(l5FairValue1p * 100) / 100,
                    l5_sog: l5Sog,
                    shots_per_60: shotsPer60,
                    proj_toi: projToi,
                    is_home: isHome,
                    opponent_factor: opponentFactor,
                    pace_factor: paceFactor,
                    consistency_score:
                      Math.round(firstPeriodConsistencyScore * 1000) / 1000,
                    matchup_score:
                      Math.round(firstPeriodMatchupScore * 1000) / 1000,
                  },
                };

                const edgePct1p = computeEdgePct(mu1p, syntheticLine1p);
                applyNhlDecisionBasisMeta(payloadData1p, {
                  usingRealLine: !!realPropLine1p,
                  edgePct: edgePct1p,
                });
                if (!realPropLine1p && payloadData1p.decision_basis_meta) {
                  payloadData1p.decision_basis_meta.market_line_source = 'synthetic_fallback';
                }

                const card1p = {
                  id: cardId1p,
                  gameId: resolvedGameId,
                  sport: 'NHL',
                  cardType: 'nhl-player-shots-1p',
                  cardTitle: `${playerName} Shots on Goal (1P)`,
                  createdAt: timestamp,
                  payloadData: payloadData1p,
                };
                attachRunId(card1p, jobRunId);

                try {
                  insertCardPayload(card1p);
                  try {
                    recordNhlProjectionTelemetry(recordProjectionEntry, card1p);
                  } catch (telemetryErr) {
                    console.warn(
                      `[${JOB_NAME}] Projection telemetry skipped for ${card1p.id}: ${telemetryErr.message}`,
                    );
                  }
                  cardsCreated++;
                  console.log(
                    `[${JOB_NAME}] ✓ Created ${firstPeriodEdge.tier} 1P card: ${playerName} ${firstPeriodEdge.direction} ${syntheticLine1p} (fair ${fairLine1p}, conf ${Math.round(firstPeriodConfidence * 100)}%)`,
                  );
                } catch (insertErr) {
                  console.error(
                    `[${JOB_NAME}] Failed to insert 1P card: ${insertErr.message}`,
                  );
                }
              } else if (firstPeriodDecision.action === 'PASS') {
                console.log(
                  `[${JOB_NAME}] Skipping 1P ${playerName} ${firstPeriodEdge.direction} ${syntheticLine1p}: PASS (consistency=${firstPeriodConsistencyScore.toFixed(2)}, matchup=${firstPeriodMatchupScore.toFixed(2)})`,
                );
              }
            }
          } catch (err) {
            console.error(
              `[${JOB_NAME}] Error processing ${player.player_name}: ${err.message}`,
            );
          }
        }
      }

      const result = {
        gamesProcessed: games.length,
        cardsCreated,
      };

      markJobRunSuccess(jobRunId, result);

      // Gap 7: setCurrentRunId called unconditionally on the success path,
      // regardless of whether any cards were created. This ensures run_state
      // is always updated after a successful model run.
      try {
        setCurrentRunId(jobRunId, 'nhl_props');
      } catch (runStateError) {
        console.error(
          `[${JOB_NAME}] Failed to update run state: ${runStateError.message}`,
        );
      }

      console.log(
        `[${JOB_NAME}] ✅ Job complete: ${cardsCreated} cards created from ${games.length} games`,
      );

      return { success: true, ...result };
    } catch (err) {
      console.error(`[${JOB_NAME}] Job failed:`, err);
      markJobRunFailure(jobRunId, { error: err.message, stack: err.stack });
      return { success: false, error: err.message };
    }
  });
}

// Run if called directly
if (require.main === module) {
  runNHLPlayerShotsModel()
    .then((result) => {
      console.log('[run_nhl_player_shots_model] Result:', result);
      process.exit(result.success ? 0 : 1);
    })
    .catch((err) => {
      console.error('[run_nhl_player_shots_model] Fatal error:', err);
      process.exit(1);
    });
}

module.exports = { runNHLPlayerShotsModel };
