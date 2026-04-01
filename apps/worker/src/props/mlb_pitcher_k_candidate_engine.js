'use strict';

const { getDatabase } = require('@cheddar-logic/data');
const {
  resolveMlbTeamLookupKeys,
  checkPitcherFreshness,
  validatePitcherKInputs,
  buildPitcherKObject,
  buildPitcherStrikeoutLookback,
} = require('../jobs/run_mlb_model');

const MARKET_FAMILY = 'mlb_pitcher_k';
const MARKET_TYPE = 'pitcher_strikeouts';
const SELECTION_TYPE = 'UNDER';
const REASON_CODES = Object.freeze({
  PITCHER_DATA_MISSING: 'PITCHER_DATA_MISSING',
  PITCHER_DATA_STALE: 'PITCHER_DATA_STALE',
  PITCHER_REQUIRED_FIELD_NULL: 'PITCHER_REQUIRED_FIELD_NULL',
  UNDER_HISTORY_THIN: 'UNDER_HISTORY_THIN',
  UNQUALIFIED_LEASH: 'UNQUALIFIED_LEASH',
  CANDIDATE_SCORE_TOO_LOW: 'CANDIDATE_SCORE_TOO_LOW',
  RECENT_K_DROP_MAJOR: 'RECENT_K_DROP_MAJOR',
  RECENT_K_DROP_MINOR: 'RECENT_K_DROP_MINOR',
  PITCH_COUNT_SUPPRESSION: 'PITCH_COUNT_SUPPRESSION',
  RECENT_IP_SUPPRESSION: 'RECENT_IP_SUPPRESSION',
  HOT_WEATHER: 'HOT_WEATHER',
  UNDER_HISTORY_STRONG: 'UNDER_HISTORY_STRONG',
  UNDER_HISTORY_SOLID: 'UNDER_HISTORY_SOLID',
});

function safeNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function incrementReason(reasonCounts, code) {
  if (!code) return;
  reasonCounts[code] = (reasonCounts[code] || 0) + 1;
}

function summarizeStrikeoutHistory(history) {
  const rows = Array.isArray(history) ? history : [];
  const validRows = rows.filter(
    (row) =>
      Number.isFinite(Number(row?.strikeouts)) &&
      Number.isFinite(Number(row?.number_of_pitches)) &&
      Number.isFinite(Number(row?.innings_pitched)),
  );
  const lastFive = validRows.slice(0, 5);
  const lastTen = validRows.slice(0, 10);
  const avg = (values) => {
    if (values.length === 0) return null;
    const total = values.reduce((sum, value) => sum + value, 0);
    return total / values.length;
  };

  return {
    starts_available: validRows.length,
    avg_k_last5: avg(lastFive.map((row) => Number(row.strikeouts))),
    avg_k_last10: avg(lastTen.map((row) => Number(row.strikeouts))),
    avg_pitch_count_last3: avg(validRows.slice(0, 3).map((row) => Number(row.number_of_pitches))),
    avg_ip_last3: avg(validRows.slice(0, 3).map((row) => Number(row.innings_pitched))),
  };
}

function scoreCandidateProfile({ pitcher, weather, historySummary }) {
  const reasonCodes = [];
  let priorityScore = 0;

  const seasonK9 = safeNumber(pitcher.k_per_9);
  const recentK9 = safeNumber(pitcher.recent_k_per_9);
  const recentIp = safeNumber(pitcher.recent_ip);
  const avgPitchCountLast3 =
    safeNumber(historySummary.avg_pitch_count_last3) ??
    safeNumber(Array.isArray(pitcher.last_three_pitch_counts)
      ? pitcher.last_three_pitch_counts.reduce((sum, value) => sum + Number(value || 0), 0) /
          pitcher.last_three_pitch_counts.length
      : null);
  const avgKLast10 = safeNumber(historySummary.avg_k_last10);
  const avgKLast5 = safeNumber(historySummary.avg_k_last5);
  const tempF = safeNumber(weather?.temp_f);
  const kDelta =
    seasonK9 !== null && recentK9 !== null ? seasonK9 - recentK9 : null;

  if (kDelta !== null && kDelta >= 1.0) {
    priorityScore += 2;
    reasonCodes.push(REASON_CODES.RECENT_K_DROP_MAJOR);
  } else if (kDelta !== null && kDelta >= 0.35) {
    priorityScore += 1;
    reasonCodes.push(REASON_CODES.RECENT_K_DROP_MINOR);
  }

  if (avgPitchCountLast3 !== null && avgPitchCountLast3 < 90) {
    priorityScore += 2;
    reasonCodes.push(REASON_CODES.PITCH_COUNT_SUPPRESSION);
  } else if (avgPitchCountLast3 !== null && avgPitchCountLast3 < 93) {
    priorityScore += 1;
    reasonCodes.push(REASON_CODES.PITCH_COUNT_SUPPRESSION);
  }

  if (recentIp !== null && recentIp < 5.5) {
    priorityScore += 1.5;
    reasonCodes.push(REASON_CODES.RECENT_IP_SUPPRESSION);
  } else if (recentIp !== null && recentIp < 5.9) {
    priorityScore += 1;
    reasonCodes.push(REASON_CODES.RECENT_IP_SUPPRESSION);
  }

  if (avgKLast5 !== null && avgKLast5 <= 4.8) {
    priorityScore += 2;
    reasonCodes.push(REASON_CODES.UNDER_HISTORY_STRONG);
  } else if (avgKLast10 !== null && avgKLast10 <= 5.6) {
    priorityScore += 1;
    reasonCodes.push(REASON_CODES.UNDER_HISTORY_SOLID);
  }

  if (tempF !== null && tempF >= 85) {
    priorityScore += 0.5;
    reasonCodes.push(REASON_CODES.HOT_WEATHER);
  }

  return {
    priorityScore: Math.round(priorityScore * 10) / 10,
    confidence: priorityScore >= 5 ? 'HIGH' : priorityScore >= 3 ? 'MEDIUM' : null,
    reasonCodes,
    leashQualified:
      (avgPitchCountLast3 !== null && avgPitchCountLast3 < 93) ||
      (recentIp !== null && recentIp < 5.8),
  };
}

function lookupPitcherRow(db, teamName) {
  if (!db || !teamName) return null;
  const stmt = db.prepare(`
    SELECT *
    FROM mlb_pitcher_stats
    WHERE team = ?
    ORDER BY updated_at DESC
    LIMIT 1
  `);
  for (const lookupKey of resolveMlbTeamLookupKeys(teamName)) {
    const row = stmt.get(lookupKey);
    if (row) return row;
  }
  return null;
}

function lookupWeatherRow(db, game) {
  if (!db || !game?.home_team || !game?.game_time_utc) return null;
  const gameDate = String(game.game_time_utc).slice(0, 10);
  return (
    db
      .prepare(`
        SELECT temp_f, wind_mph, wind_dir, conditions
        FROM mlb_game_weather
        WHERE game_date = ?
          AND home_team = ?
        ORDER BY rowid DESC
        LIMIT 1
      `)
      .get(gameDate, game.home_team) || null
  );
}

function getUpcomingMlbGames(db, gameIds = null) {
  const requestedGameIds = Array.isArray(gameIds)
    ? gameIds.map((value) => String(value || '').trim()).filter(Boolean)
    : [];

  if (requestedGameIds.length > 0) {
    return db
      .prepare(`
        SELECT game_id, sport, home_team, away_team, game_time_utc, status
        FROM games
        WHERE LOWER(sport) = 'mlb'
          AND game_id IN (${requestedGameIds.map(() => '?').join(', ')})
        ORDER BY game_time_utc ASC
      `)
      .all(...requestedGameIds);
  }

  return db
    .prepare(`
      SELECT game_id, sport, home_team, away_team, game_time_utc, status
      FROM games
      WHERE LOWER(sport) = 'mlb'
        AND status = 'scheduled'
        AND game_time_utc >= datetime('now')
        AND game_time_utc <= datetime('now', '+36 hours')
      ORDER BY game_time_utc ASC
    `)
    .all();
}

function buildPitcherCandidate({
  db,
  game,
  side,
  reasonCounts,
  todayDate,
}) {
  const teamName = side === 'home' ? game.home_team : game.away_team;
  const row = lookupPitcherRow(db, teamName);

  if (!row) {
    incrementReason(reasonCounts, REASON_CODES.PITCHER_DATA_MISSING);
    return null;
  }

  const freshness = checkPitcherFreshness(row, todayDate);
  if (freshness === 'STALE') {
    incrementReason(reasonCounts, REASON_CODES.PITCHER_DATA_STALE);
    return null;
  }

  const pitcher = buildPitcherKObject(row);
  const validationError = validatePitcherKInputs(pitcher);
  if (validationError) {
    incrementReason(reasonCounts, REASON_CODES.PITCHER_REQUIRED_FIELD_NULL);
    return null;
  }

  const strikeoutHistory = buildPitcherStrikeoutLookback(
    db,
    row.mlb_id,
    new Date(game.game_time_utc || Date.now()).getUTCFullYear(),
    10,
  );
  const historySummary = summarizeStrikeoutHistory(strikeoutHistory);
  if (historySummary.starts_available < 5) {
    incrementReason(reasonCounts, REASON_CODES.UNDER_HISTORY_THIN);
    return null;
  }

  const weather = lookupWeatherRow(db, game);
  const scored = scoreCandidateProfile({
    pitcher,
    weather,
    historySummary,
  });

  if (!scored.leashQualified) {
    incrementReason(reasonCounts, REASON_CODES.UNQUALIFIED_LEASH);
    return null;
  }

  if (!scored.confidence) {
    incrementReason(reasonCounts, REASON_CODES.CANDIDATE_SCORE_TOO_LOW);
    return null;
  }

  return {
    game_id: game.game_id,
    player_id: String(row.mlb_id || `${game.game_id}:${side}`),
    player_name: row.full_name || `${teamName} SP`,
    market_family: MARKET_FAMILY,
    market_type: MARKET_TYPE,
    selection_type: SELECTION_TYPE,
    priority_score: scored.priorityScore,
    confidence: scored.confidence,
    reason_codes: scored.reasonCodes,
    team: teamName,
    side,
    game_time_utc: game.game_time_utc,
  };
}

function buildMlbPitcherKCandidateSet({
  games = [],
  gameIds = null,
  now = new Date().toISOString(),
  db = getDatabase(),
} = {}) {
  const requestedGameIds = new Set(
    Array.isArray(gameIds)
      ? gameIds.map((value) => String(value || '').trim()).filter(Boolean)
      : [],
  );
  const todayDate = String(now).slice(0, 10);
  const sourceGames =
    Array.isArray(games) && games.length > 0 ? games : getUpcomingMlbGames(db, gameIds);
  const mlbGames = sourceGames.filter((game) => {
    const sport = String(game?.sport || '').toLowerCase();
    if (sport !== 'mlb') return false;
    if (requestedGameIds.size === 0) return true;
    return requestedGameIds.has(String(game.game_id));
  });

  const candidates = [];
  const reasonCounts = {};
  let totalCandidates = 0;
  let filteredOut = 0;

  for (const game of mlbGames) {
    for (const side of ['home', 'away']) {
      totalCandidates += 1;
      const candidate = buildPitcherCandidate({
        db,
        game,
        side,
        reasonCounts,
        todayDate,
      });
      if (!candidate) {
        filteredOut += 1;
        continue;
      }
      candidates.push(candidate);
    }
  }

  candidates.sort((left, right) => {
    if (right.priority_score !== left.priority_score) {
      return right.priority_score - left.priority_score;
    }
    return `${left.game_id}:${left.player_name}`.localeCompare(
      `${right.game_id}:${right.player_name}`,
    );
  });

  return {
    candidates,
    meta: {
      total_candidates: totalCandidates,
      filtered_out: filteredOut,
      reason_counts: reasonCounts,
    },
  };
}

module.exports = {
  MARKET_FAMILY,
  MARKET_TYPE,
  SELECTION_TYPE,
  REASON_CODES,
  summarizeStrikeoutHistory,
  scoreCandidateProfile,
  buildMlbPitcherKCandidateSet,
};
