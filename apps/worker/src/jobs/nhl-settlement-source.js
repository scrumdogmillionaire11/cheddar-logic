'use strict';

const NHL_API_BASE_URL = 'https://api-web.nhle.com/v1/gamecenter';
const DEFAULT_NHL_API_TIMEOUT_MS = Math.max(
  3000,
  Number(process.env.NHL_API_TIMEOUT_MS) || 12000,
);

function toFiniteNumberOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizePlayerName(name) {
  return String(name || '')
    .trim()
    .toLowerCase()
    .replace(/[.'\u2019-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function resolvePeriodNumber(payload) {
  return (
    toFiniteNumberOrNull(payload?.periodDescriptor?.number) ??
    toFiniteNumberOrNull(payload?.clock?.period) ??
    toFiniteNumberOrNull(payload?.period) ??
    toFiniteNumberOrNull(payload?.currentPeriod) ??
    null
  );
}

function parsePeriodScoresFromLanding(landingPayload) {
  const candidates = [];

  if (Array.isArray(landingPayload?.summary?.scoring)) {
    candidates.push(...landingPayload.summary.scoring);
  }

  if (Array.isArray(landingPayload?.summary?.scoringByPeriod)) {
    candidates.push(...landingPayload.summary.scoringByPeriod);
  }

  if (Array.isArray(landingPayload?.linescore?.byPeriod)) {
    candidates.push(...landingPayload.linescore.byPeriod);
  }

  const periodOne = candidates.find((row) => {
    const period =
      toFiniteNumberOrNull(row?.periodDescriptor?.number) ??
      toFiniteNumberOrNull(row?.period) ??
      toFiniteNumberOrNull(row?.number);
    return period === 1;
  });

  if (!periodOne) {
    return { home: null, away: null };
  }

  const home =
    toFiniteNumberOrNull(periodOne?.homeScore) ??
    toFiniteNumberOrNull(periodOne?.home);
  const away =
    toFiniteNumberOrNull(periodOne?.awayScore) ??
    toFiniteNumberOrNull(periodOne?.away);

  if (!Number.isFinite(home) || !Number.isFinite(away)) {
    return { home: null, away: null };
  }

  return { home, away };
}

function normalizeNhlLandingSnapshot(landingPayload) {
  const homeScore =
    toFiniteNumberOrNull(landingPayload?.homeTeam?.score) ??
    toFiniteNumberOrNull(landingPayload?.score?.home) ??
    toFiniteNumberOrNull(landingPayload?.homeScore);
  const awayScore =
    toFiniteNumberOrNull(landingPayload?.awayTeam?.score) ??
    toFiniteNumberOrNull(landingPayload?.score?.away) ??
    toFiniteNumberOrNull(landingPayload?.awayScore);

  const firstPeriodScores = parsePeriodScoresFromLanding(landingPayload);
  const gameState = String(
    landingPayload?.gameState || landingPayload?.gameStatus || '',
  )
    .trim()
    .toUpperCase();
  const periodNumber = resolvePeriodNumber(landingPayload);
  const isFinal =
    gameState === 'FINAL' ||
    gameState === 'OFF' ||
    gameState === 'OVER' ||
    gameState === 'COMPLETE';
  const isFirstPeriodComplete =
    Number.isFinite(firstPeriodScores.home) &&
    Number.isFinite(firstPeriodScores.away) &&
    (isFinal || (Number.isFinite(periodNumber) && periodNumber >= 2));

  return {
    homeScore,
    awayScore,
    homeFirstPeriodScore: isFirstPeriodComplete ? firstPeriodScores.home : null,
    awayFirstPeriodScore: isFirstPeriodComplete ? firstPeriodScores.away : null,
    isFinal,
    isFirstPeriodComplete,
    gameState,
    periodNumber,
  };
}

function collectPlayerStatRows(node, rows = []) {
  if (!node) return rows;
  if (Array.isArray(node)) {
    for (const entry of node) {
      collectPlayerStatRows(entry, rows);
    }
    return rows;
  }

  if (typeof node !== 'object') return rows;

  const playerId =
    node.playerId ??
    node.playerID ??
    node.id ??
    node.personId ??
    node.personID ??
    node.skaterId;
  const shots =
    toFiniteNumberOrNull(node.shots) ??
    toFiniteNumberOrNull(node.sog) ??
    toFiniteNumberOrNull(node.shotsOnGoal) ??
    toFiniteNumberOrNull(node?.stats?.shots) ??
    toFiniteNumberOrNull(node?.stats?.sog) ??
    toFiniteNumberOrNull(node?.stats?.shotsOnGoal);

  if (playerId !== null && playerId !== undefined && Number.isFinite(shots)) {
    rows.push({
      playerId: String(playerId),
      shots,
      firstName:
        node?.firstName?.default ||
        node?.firstName ||
        node?.playerFirstName ||
        node?.name?.first ||
        null,
      lastName:
        node?.lastName?.default ||
        node?.lastName ||
        node?.playerLastName ||
        node?.name?.last ||
        null,
      fullName:
        node?.name?.default ||
        node?.fullName ||
        node?.playerName ||
        node?.name ||
        null,
    });
  }

  for (const value of Object.values(node)) {
    if (value && typeof value === 'object') {
      collectPlayerStatRows(value, rows);
    }
  }

  return rows;
}

function extractPlayerShotsFromBoxscore(boxscorePayload) {
  const rows = collectPlayerStatRows(boxscorePayload, []);
  const byPlayerId = {};
  const playerNamesById = {};

  for (const row of rows) {
    const key = String(row.playerId);
    const current = Number(byPlayerId[key] || 0);
    byPlayerId[key] = current + Number(row.shots || 0);

    const fullName =
      String(row.fullName || '').trim() ||
      [row.firstName, row.lastName]
        .map((v) => String(v || '').trim())
        .filter(Boolean)
        .join(' ')
        .trim();
    if (fullName) {
      playerNamesById[key] = fullName;
    }
  }

  return {
    byPlayerId,
    playerNamesById,
  };
}

function collectPlayerBlockRows(node, rows = []) {
  if (!node) return rows;
  if (Array.isArray(node)) {
    for (const entry of node) {
      collectPlayerBlockRows(entry, rows);
    }
    return rows;
  }

  if (typeof node !== 'object') return rows;

  const playerId =
    node.playerId ??
    node.playerID ??
    node.id ??
    node.personId ??
    node.personID ??
    node.skaterId;
  const blocks =
    toFiniteNumberOrNull(node.blockedShots) ??
    toFiniteNumberOrNull(node.blocked_shots) ??
    toFiniteNumberOrNull(node.bs) ??
    toFiniteNumberOrNull(node.blocked) ??
    toFiniteNumberOrNull(node?.stats?.blockedShots) ??
    toFiniteNumberOrNull(node?.stats?.blocked_shots) ??
    toFiniteNumberOrNull(node?.stats?.bs);

  if (playerId !== null && playerId !== undefined && Number.isFinite(blocks)) {
    rows.push({
      playerId: String(playerId),
      blocks,
      firstName:
        node?.firstName?.default ||
        node?.firstName ||
        node?.playerFirstName ||
        node?.name?.first ||
        null,
      lastName:
        node?.lastName?.default ||
        node?.lastName ||
        node?.playerLastName ||
        node?.name?.last ||
        null,
      fullName:
        node?.name?.default ||
        node?.fullName ||
        node?.playerName ||
        node?.name ||
        null,
    });
  }

  for (const value of Object.values(node)) {
    if (value && typeof value === 'object') {
      collectPlayerBlockRows(value, rows);
    }
  }

  return rows;
}

function extractPlayerBlocksFromBoxscore(boxscorePayload) {
  const rows = collectPlayerBlockRows(boxscorePayload, []);
  const byPlayerId = {};
  const playerNamesById = {};

  for (const row of rows) {
    const key = String(row.playerId);
    const current = Number(byPlayerId[key] || 0);
    byPlayerId[key] = current + Number(row.blocks || 0);

    const fullName =
      String(row.fullName || '').trim() ||
      [row.firstName, row.lastName]
        .map((v) => String(v || '').trim())
        .filter(Boolean)
        .join(' ')
        .trim();
    if (fullName) {
      playerNamesById[key] = fullName;
    }
  }

  return {
    byPlayerId,
    playerNamesById,
  };
}

function isShotOnGoalPlay(play) {
  const token = [
    play?.typeDescKey,
    play?.eventType,
    play?.event,
    play?.eventTypeId,
    play?.result?.eventTypeId,
    play?.result?.event,
  ]
    .map((value) => String(value || '').toLowerCase())
    .join(' ');

  if (token.includes('shot-on-goal') || token.includes('shot_on_goal')) {
    return true;
  }

  const numericCode = toFiniteNumberOrNull(play?.typeCode);
  if (numericCode === 506) return true;

  return false;
}

function extractPlayerIdFromPlay(play) {
  const details = play?.details && typeof play.details === 'object' ? play.details : {};
  const candidates = [
    details.shootingPlayerId,
    details.shooterPlayerId,
    details.playerId,
    play?.playerId,
    play?.personId,
  ];

  for (const candidate of candidates) {
    if (candidate === null || candidate === undefined || candidate === '') continue;
    return String(candidate);
  }

  return null;
}

function extractPeriodNumberFromPlay(play) {
  return (
    toFiniteNumberOrNull(play?.periodDescriptor?.number) ??
    toFiniteNumberOrNull(play?.period) ??
    toFiniteNumberOrNull(play?.about?.period) ??
    null
  );
}

function extractFirstPeriodShotsFromPlayByPlay(playByPlayPayload) {
  const plays = Array.isArray(playByPlayPayload?.plays)
    ? playByPlayPayload.plays
    : Array.isArray(playByPlayPayload?.liveData?.plays?.allPlays)
      ? playByPlayPayload.liveData.plays.allPlays
      : [];

  const byPlayerId = {};

  for (const play of plays) {
    if (extractPeriodNumberFromPlay(play) !== 1) continue;
    if (!isShotOnGoalPlay(play)) continue;

    const playerId = extractPlayerIdFromPlay(play);
    if (!playerId) continue;

    byPlayerId[playerId] = Number(byPlayerId[playerId] || 0) + 1;
  }

  return { byPlayerId };
}

function buildPlayerNameLookup(playerNamesById) {
  const byName = {};
  for (const [playerId, fullName] of Object.entries(playerNamesById || {})) {
    const normalized = normalizePlayerName(fullName);
    if (!normalized) continue;
    byName[normalized] = String(playerId);
  }
  return byName;
}

async function fetchJsonWithTimeout(url, timeoutMs, fetchImpl = fetch) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, {
      signal: controller.signal,
      headers: {
        Accept: 'application/json',
        'User-Agent': 'cheddar-logic-settlement/1.0 (+nhl-api)',
      },
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

function buildNhlApiUrls(nhlGameId) {
  const encoded = encodeURIComponent(String(nhlGameId));
  return {
    landing: `${NHL_API_BASE_URL}/${encoded}/landing`,
    boxscore: `${NHL_API_BASE_URL}/${encoded}/boxscore`,
    playByPlay: `${NHL_API_BASE_URL}/${encoded}/play-by-play`,
  };
}

function areScoreSnapshotsEqual(a, b) {
  const keys = [
    'homeScore',
    'awayScore',
    'homeFirstPeriodScore',
    'awayFirstPeriodScore',
    'isFinal',
    'isFirstPeriodComplete',
  ];

  return keys.every((key) => a?.[key] === b?.[key]);
}

function normalizeShotsSnapshot(snapshot) {
  return JSON.stringify(snapshot || {});
}

function areNhlSnapshotsEquivalent(passOne, passTwo) {
  if (!areScoreSnapshotsEqual(passOne, passTwo)) return false;

  const passOneFull = normalizeShotsSnapshot(passOne?.playerShots?.fullGameByPlayerId);
  const passTwoFull = normalizeShotsSnapshot(passTwo?.playerShots?.fullGameByPlayerId);
  if (passOneFull !== passTwoFull) return false;

  const passOne1p = normalizeShotsSnapshot(passOne?.playerShots?.firstPeriodByPlayerId);
  const passTwo1p = normalizeShotsSnapshot(passTwo?.playerShots?.firstPeriodByPlayerId);
  if (passOne1p !== passTwo1p) return false;

  const passOneBlk = normalizeShotsSnapshot(passOne?.playerBlocks?.fullGameByPlayerId);
  const passTwoBlk = normalizeShotsSnapshot(passTwo?.playerBlocks?.fullGameByPlayerId);
  return passOneBlk === passTwoBlk;
}

async function fetchNhlSettlementSnapshot({
  nhlGameId,
  timeoutMs = DEFAULT_NHL_API_TIMEOUT_MS,
  fetchImpl = fetch,
} = {}) {
  if (!nhlGameId) {
    return { available: false, reason: 'missing_nhl_game_id' };
  }

  const urls = buildNhlApiUrls(nhlGameId);
  const [landingResult, boxscoreResult, pbpResult] = await Promise.allSettled([
    fetchJsonWithTimeout(urls.landing, timeoutMs, fetchImpl),
    fetchJsonWithTimeout(urls.boxscore, timeoutMs, fetchImpl),
    fetchJsonWithTimeout(urls.playByPlay, timeoutMs, fetchImpl),
  ]);

  if (landingResult.status !== 'fulfilled') {
    return {
      available: false,
      reason: 'landing_fetch_failed',
      error: landingResult.reason?.message || String(landingResult.reason || ''),
    };
  }

  const landingSnapshot = normalizeNhlLandingSnapshot(landingResult.value);
  const boxscoreData =
    boxscoreResult.status === 'fulfilled'
      ? extractPlayerShotsFromBoxscore(boxscoreResult.value)
      : { byPlayerId: {}, playerNamesById: {} };
  const boxscoreBlocksData =
    boxscoreResult.status === 'fulfilled'
      ? extractPlayerBlocksFromBoxscore(boxscoreResult.value)
      : { byPlayerId: {}, playerNamesById: {} };
  const pbpData =
    pbpResult.status === 'fulfilled'
      ? extractFirstPeriodShotsFromPlayByPlay(pbpResult.value)
      : { byPlayerId: {} };

  return {
    available: true,
    nhlGameId: String(nhlGameId),
    ...landingSnapshot,
    playerShots: {
      fullGameByPlayerId: boxscoreData.byPlayerId,
      firstPeriodByPlayerId: pbpData.byPlayerId,
      playerNamesById: boxscoreData.playerNamesById,
      playerIdByNormalizedName: buildPlayerNameLookup(boxscoreData.playerNamesById),
      sources: {
        boxscore: boxscoreResult.status === 'fulfilled',
        playByPlay: pbpResult.status === 'fulfilled',
      },
    },
    playerBlocks: {
      fullGameByPlayerId: boxscoreBlocksData.byPlayerId,
      playerNamesById: boxscoreBlocksData.playerNamesById,
      playerIdByNormalizedName: buildPlayerNameLookup(boxscoreBlocksData.playerNamesById),
      sources: {
        boxscore: boxscoreResult.status === 'fulfilled',
      },
    },
  };
}

/**
 * Canonical resolver for full-game NHL player shots.
 *
 * Tries direct playerId lookup first, then falls back to normalized-name
 * lookup via playerIdByNormalizedName. Returns { value, resolvedBy } on
 * success, or null if the player cannot be found.
 *
 * @param {object} snapshot - result of fetchNhlSettlementSnapshot
 * @param {string|number|null} playerId
 * @param {string|null} playerName
 * @returns {{ value: number, resolvedBy: 'id' | 'name' } | null}
 */
function resolveNhlFullGamePlayerShots(snapshot, playerId, playerName) {
  const playerShots = snapshot?.playerShots;
  if (!playerShots || typeof playerShots !== 'object') return null;
  const byId = playerShots.fullGameByPlayerId;
  if (!byId || typeof byId !== 'object') return null;

  const idKey = playerId !== null && playerId !== undefined ? String(playerId) : null;
  if (idKey) {
    const byIdValue = toFiniteNumberOrNull(byId[idKey]);
    if (byIdValue !== null) return { value: byIdValue, resolvedBy: 'id' };
  }

  const normalized = normalizePlayerName(playerName);
  if (normalized) {
    const nameMap = playerShots.playerIdByNormalizedName;
    if (nameMap && typeof nameMap === 'object') {
      const mappedId = nameMap[normalized];
      if (mappedId) {
        const byNameValue = toFiniteNumberOrNull(byId[String(mappedId)]);
        if (byNameValue !== null) return { value: byNameValue, resolvedBy: 'name' };
      }
    }
  }

  return null;
}

module.exports = {
  DEFAULT_NHL_API_TIMEOUT_MS,
  areNhlSnapshotsEquivalent,
  buildNhlApiUrls,
  extractFirstPeriodShotsFromPlayByPlay,
  extractPlayerBlocksFromBoxscore,
  extractPlayerShotsFromBoxscore,
  fetchNhlSettlementSnapshot,
  normalizeNhlLandingSnapshot,
  normalizePlayerName,
  resolveNhlFullGamePlayerShots,
};
