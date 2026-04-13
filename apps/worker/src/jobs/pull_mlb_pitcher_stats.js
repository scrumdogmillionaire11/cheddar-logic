'use strict';

require('dotenv').config();
const { v4: uuidV4 } = require('uuid');

const {
  getDatabase,
  insertJobRun,
  markJobRunSuccess,
  markJobRunFailure,
  shouldRunJobKey,
} = require('@cheddar-logic/data');
const { withDbSafe } = require('../utils/with-db-safe');

const JOB_NAME = 'pull_mlb_pitcher_stats';
const MLB_API_BASE = 'https://statsapi.mlb.com/api/v1';
const MLB_SEASON = 2026;

function todayDateString() {
  return new Date().toISOString().slice(0, 10);
}

async function fetchJson(url) {
  const response = await fetch(url, {
    headers: { 'user-agent': 'cheddar-logic-worker' },
  });
  if (!response.ok) {
    throw new Error(`MLB API ${response.status} for ${url}`);
  }
  return response.json();
}

async function fetchSchedule(date) {
  const url = `${MLB_API_BASE}/schedule?sportId=1&date=${date}&hydrate=probablePitcher(note),team`;
  return fetchJson(url);
}

async function fetchProbablePitcherIds(date) {
  const payload = await fetchSchedule(date);

  const ids = new Set();
  const dates = Array.isArray(payload.dates) ? payload.dates : [];
  for (const d of dates) {
    const games = Array.isArray(d.games) ? d.games : [];
    for (const game of games) {
      const homePitcher = game?.teams?.home?.probablePitcher;
      const awayPitcher = game?.teams?.away?.probablePitcher;
      if (homePitcher?.id) ids.add(Number(homePitcher.id));
      if (awayPitcher?.id) ids.add(Number(awayPitcher.id));
    }
  }
  return [...ids];
}

/**
 * Build a Map<pitcherId, teamAbbreviation> from a schedule API payload.
 * The schedule `hydrate=probablePitcher,team` response includes team.abbreviation
 * alongside each probablePitcher — this is the canonical join key used by
 * run_mlb_model.js (which queries mlb_pitcher_stats WHERE team = odds_snapshot.home_team).
 */
function buildPitcherTeamMap(schedulePayload) {
  const map = new Map();
  const dates = Array.isArray(schedulePayload?.dates) ? schedulePayload.dates : [];
  for (const d of dates) {
    const games = Array.isArray(d.games) ? d.games : [];
    for (const game of games) {
      for (const side of ['home', 'away']) {
        const pitcher = game?.teams?.[side]?.probablePitcher;
        const abbrev = game?.teams?.[side]?.team?.abbreviation;
        if (pitcher?.id && abbrev) {
          map.set(Number(pitcher.id), abbrev);
        }
      }
    }
  }
  return map;
}

function ensureMlbGamePkMap(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS mlb_game_pk_map (
      game_pk_key TEXT PRIMARY KEY,
      game_pk     INTEGER NOT NULL,
      game_date   TEXT NOT NULL,
      updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_mlb_game_pk_map_date
      ON mlb_game_pk_map (game_date);
  `);
}

function upsertGamePkMap(db, gamePkKey, gamePk, gameDate) {
  ensureMlbGamePkMap(db);
  db.prepare(`
    INSERT INTO mlb_game_pk_map (game_pk_key, game_pk, game_date)
    VALUES (?, ?, ?)
    ON CONFLICT(game_pk_key) DO UPDATE SET
      game_pk = excluded.game_pk,
      game_date = excluded.game_date,
      updated_at = datetime('now')
  `).run(gamePkKey, gamePk, gameDate);
}

async function storeGamePkMap(db, date) {
  const payload = await fetchSchedule(date);
  const dates = Array.isArray(payload.dates) ? payload.dates : [];
  let count = 0;
  for (const d of dates) {
    const games = Array.isArray(d.games) ? d.games : [];
    for (const game of games) {
      const gamePk = game?.gamePk;
      const gameDate = game?.gameDate?.slice(0, 10) || date;
      const homeAbbr = game?.teams?.home?.team?.abbreviation;
      const awayAbbr = game?.teams?.away?.team?.abbreviation;
      if (!gamePk || !homeAbbr || !awayAbbr) continue;
      const gamePkKey = `${gameDate}|${homeAbbr}|${awayAbbr}`;
      upsertGamePkMap(db, gamePkKey, gamePk, gameDate);
      count += 1;
    }
  }
  return count;
}

function toFinite(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function safeDiv(numerator, denominator, multiplier = 1) {
  const n = toFinite(numerator);
  const d = toFinite(denominator);
  if (n === null || d === null || d === 0) return null;
  return (n / d) * multiplier;
}

function estimatePitcherXFip({ kPct, bbPct, hrPer9 }) {
  const kRate = toFinite(kPct);
  const walkRate = toFinite(bbPct);
  const hrRate = toFinite(hrPer9);
  if (kRate === null || walkRate === null || hrRate === null) return null;

  // xFIP-style run estimator centered near league-average run prevention.
  const xFip = 4.2 + 10 * (walkRate - 0.085) - 12 * (kRate - 0.225) + 0.35 * (hrRate - 1.1);
  return Math.max(2.0, Math.min(6.8, Math.round(xFip * 100) / 100));
}

/**
 * Estimate SIERA (Skill-Interactive ERA) from per-PA rates.
 * Formula (simplified, per FanGraphs): SIERA = 6.145 - 16.986*(K/PA) + 11.434*(BB/PA) - 1.858*(GB_rate)
 * GB rate defaults to MLB league average (≈0.44) when ground-ball tracking is not available.
 * xERA (Statcast barrel/hard-hit based) is intentionally separate — see follow-on WI.
 *
 * @param {{ kPct: number|null, bbPct: number|null, gbRate?: number|null }} params
 * @returns {number|null}
 */
function estimatePitcherSiera({ kPct, bbPct, gbRate = null }) {
  // Explicit null guard: toFinite(null) === 0 because Number(null)===0; check before converting.
  if (kPct == null || bbPct == null) return null;
  const k = toFinite(kPct);
  const bb = toFinite(bbPct);
  if (k === null || bb === null) return null;
  // Use provided GB rate or fall back to MLB league average.
  const gb = (gbRate != null && toFinite(gbRate) !== null) ? toFinite(gbRate) : 0.44;
  const siera = 6.145 - 16.986 * k + 11.434 * bb - 1.858 * gb;
  return Math.max(2.0, Math.min(6.8, Math.round(siera * 100) / 100));
}

async function fetchPitcherSeasonStats(pitcherId, season = MLB_SEASON) {
  const url = `${MLB_API_BASE}/people/${pitcherId}/stats?stats=season&season=${season}&group=pitching`;
  const payload = await fetchJson(url);

  const stats = payload?.stats?.[0]?.splits?.[0]?.stat;
  if (!stats) {
    return {
      era: null,
      whip: null,
      k_per_9: null,
      innings_pitched: null,
      season_starts: null,
      season_k_pct: null,
      bb_pct: null,
      hr_per_9: null,
      x_fip: null,
      siera: null,
      // x_era requires Statcast barrel/hard-hit data — implement in separate WI.
      x_era: null,
    };
  }

  const ip = toFinite(stats.inningsPitched);
  const strikeOuts = toFinite(stats.strikeOuts);
  const walks = toFinite(stats.baseOnBalls);
  const homeRuns = toFinite(stats.homeRuns);
  const battersFaced = toFinite(stats.battersFaced);
  const seasonKPct = safeDiv(strikeOuts, battersFaced);
  const bbPct = safeDiv(walks, battersFaced);
  const hrPer9 = safeDiv(homeRuns, ip, 9);
  return {
    era: toFinite(stats.era),
    whip: toFinite(stats.whip),
    // pitcher_input_schema.md: season_k9 required — halt if missing
    k_per_9: safeDiv(strikeOuts, ip, 9),
    innings_pitched: ip,
    // pitcher_input_schema.md: season_starts required — halt if missing
    season_starts: toFinite(stats.gamesStarted),
    // pitcher_input_schema.md: season_k_pct required for Block 3 trend
    season_k_pct: seasonKPct,
    bb_pct: bbPct,
    hr_per_9: hrPer9,
    x_fip: estimatePitcherXFip({ kPct: seasonKPct, bbPct, hrPer9 }),
    siera: estimatePitcherSiera({ kPct: seasonKPct, bbPct }),
    // x_era requires Statcast barrel/hard-hit data — implement in separate WI.
    x_era: null,
  };
}

async function fetchPitcherRecentStats(pitcherId, season = MLB_SEASON) {
  const url = `${MLB_API_BASE}/people/${pitcherId}/stats?stats=gameLog&season=${season}&group=pitching`;
  const payload = await fetchJson(url);

  const splits = Array.isArray(payload?.stats?.[0]?.splits)
    ? payload.stats[0].splits
    : [];

  const last5 = splits.slice(-5);
  if (last5.length === 0) {
    return {
      recent_k_per_9: null,
      recent_ip: null,
      allSplits: splits,
      last_three_pitch_counts: null,
      last_three_ip: null,
      k_pct_last_4_starts: null,
      k_pct_prior_4_starts: null,
      days_since_last_start: null,
    };
  }

  let totalK = 0;
  let totalIp = 0;
  let validStarts = 0;

  for (const entry of last5) {
    const ip = toFinite(entry?.stat?.inningsPitched);
    const k = toFinite(entry?.stat?.strikeOuts);
    if (ip !== null && k !== null) {
      totalK += k;
      totalIp += ip;
      validStarts += 1;
    }
  }

  // pitcher_input_schema.md: last_three_pitch_counts required — halt if missing
  // splits are chronological (oldest first); most recent last
  const last3 = splits.slice(-3);
  const pitchCountArr = last3
    .map((s) => toFinite(s?.stat?.numberOfPitches))
    .filter((v) => v !== null);
  // Spec: most recent first
  const last_three_pitch_counts =
    pitchCountArr.length >= 3
      ? JSON.stringify([...pitchCountArr].reverse())
      : null;

  const ipArr = last3
    .map((s) => toFinite(s?.stat?.inningsPitched))
    .filter((v) => v !== null);
  const last_three_ip =
    ipArr.length >= 3 ? JSON.stringify([...ipArr].reverse()) : null;

  // pitcher_input_schema.md: rolling_4start_k_pct required if >= 4 starts
  function kPctWindow(window) {
    const totalKw = window.reduce(
      (acc, e) => acc + (toFinite(e?.stat?.strikeOuts) ?? 0),
      0,
    );
    const totalBF = window.reduce(
      (acc, e) => acc + (toFinite(e?.stat?.battersFaced) ?? 0),
      0,
    );
    return totalBF > 0 ? totalKw / totalBF : null;
  }

  const k_pct_last_4_starts = kPctWindow(splits.slice(-4));
  const k_pct_prior_4_starts = kPctWindow(splits.slice(-8, -4));

  // pitcher_input_schema.md: days_since_last_start required — halt if missing
  let days_since_last_start = null;
  if (splits.length > 0) {
    const lastDate = splits[splits.length - 1]?.date;
    if (lastDate) {
      const diffMs = Date.now() - new Date(lastDate).getTime();
      days_since_last_start = Math.floor(diffMs / 86_400_000);
    }
  }

  return {
    recent_k_per_9:
      validStarts > 0 && totalIp > 0 ? (totalK / totalIp) * 9 : null,
    recent_ip: validStarts > 0 ? totalIp / validStarts : null,
    allSplits: splits,
    last_three_pitch_counts,
    last_three_ip,
    k_pct_last_4_starts,
    k_pct_prior_4_starts,
    days_since_last_start,
  };
}

function ensureGameLogsTable(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS mlb_pitcher_game_logs (
      id               TEXT PRIMARY KEY,
      mlb_pitcher_id   INTEGER NOT NULL,
      game_pk          INTEGER NOT NULL,
      game_date        TEXT NOT NULL,
      season           INTEGER NOT NULL,
      innings_pitched  REAL,
      strikeouts       INTEGER,
      walks            INTEGER,
      hits             INTEGER,
      earned_runs      INTEGER,
      -- Added WI-0596: required for last_three_pitch_counts and k_pct window derivation
      number_of_pitches INTEGER,
      batters_faced     INTEGER,
      opponent          TEXT,
      home_away         TEXT,
      updated_at        TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE (mlb_pitcher_id, game_pk)
    );
    CREATE INDEX IF NOT EXISTS idx_mlb_pitcher_game_logs_pitcher_date
      ON mlb_pitcher_game_logs (mlb_pitcher_id, game_date);
  `);

  // Idempotent migrations for tables created before WI-0596
  const migrations = [
    'ALTER TABLE mlb_pitcher_game_logs ADD COLUMN number_of_pitches INTEGER',
    'ALTER TABLE mlb_pitcher_game_logs ADD COLUMN batters_faced INTEGER',
  ];
  for (const sql of migrations) {
    try { db.exec(sql); } catch (_) { /* column already exists */ }
  }
}

function upsertGameLogs(db, mlbPitcherId, splits, season) {
  ensureGameLogsTable(db);
  const stmt = db.prepare(`
    INSERT INTO mlb_pitcher_game_logs
      (id, mlb_pitcher_id, game_pk, game_date, season,
       innings_pitched, strikeouts, walks, hits, earned_runs,
       number_of_pitches, batters_faced, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(mlb_pitcher_id, game_pk) DO UPDATE SET
      innings_pitched   = excluded.innings_pitched,
      strikeouts        = excluded.strikeouts,
      walks             = excluded.walks,
      hits              = excluded.hits,
      earned_runs       = excluded.earned_runs,
      number_of_pitches = excluded.number_of_pitches,
      batters_faced     = excluded.batters_faced,
      updated_at        = datetime('now')
  `);
  let count = 0;
  for (const split of splits) {
    const gamePk = split?.game?.gamePk;
    const gameDate = split?.date;
    if (!gamePk || !gameDate) continue;
    const stat = split?.stat ?? {};
    const splitSeason =
      parseInt(split?.season, 10) ||
      parseInt(String(gameDate).slice(0, 4), 10) ||
      season;
    stmt.run(
      uuidV4(),
      mlbPitcherId,
      gamePk,
      gameDate,
      splitSeason,
      parseFloat(stat.inningsPitched) || null,
      parseInt(stat.strikeOuts, 10) || null,
      parseInt(stat.baseOnBalls, 10) || null,
      parseInt(stat.hits, 10) || null,
      parseInt(stat.earnedRuns, 10) || null,
      parseInt(stat.numberOfPitches, 10) || null,
      parseInt(stat.battersFaced, 10) || null,
    );
    count += 1;
  }
  return count;
}

async function fetchPitcherInfo(pitcherId) {
  const url = `${MLB_API_BASE}/people/${pitcherId}`;
  const payload = await fetchJson(url);
  const person = payload?.people?.[0];
  return {
    full_name: person?.fullName || null,
    team: person?.currentTeam?.name || null,
    // pitcher_input_schema.md: handedness required for opp splits
    handedness: person?.pitchHand?.code || null, // 'R' or 'L'
  };
}

/**
 * Returns true when a season stats object has no meaningful data — i.e. Opening Day
 * or the pitcher has not yet appeared in a game this season.
 */
function isSeasonStatsEmpty(seasonStats) {
  return (
    seasonStats.era === null &&
    seasonStats.k_per_9 === null &&
    (seasonStats.season_starts === null || seasonStats.season_starts === 0)
  );
}

async function fetchAllPitcherData(pitcherId, { teamFromSchedule = null } = {}) {
  const [info, seasonStats, recentStats] = await Promise.all([
    fetchPitcherInfo(pitcherId),
    fetchPitcherSeasonStats(pitcherId, MLB_SEASON),
    fetchPitcherRecentStats(pitcherId, MLB_SEASON),
  ]);

  // Opening Day / early-season fallback: if current season has no stats yet (no games played),
  // pull the prior season as a proxy so ERA, k_per_9, season_starts etc. are populated.
  let effectiveSeasonStats = seasonStats;
  let effectiveRecentStats = recentStats;
  let statsSourceSeason = MLB_SEASON;
  let supplementalSplits = [];
  let priorSeasonStats = null;
  let priorRecentStats = null;
  const currentLookbackCount = recentStats?.allSplits?.length ?? 0;
  const needsPriorSeasonFallback = isSeasonStatsEmpty(seasonStats);
  const needsPriorSeasonSupplement = currentLookbackCount < 10;

  if (needsPriorSeasonFallback || needsPriorSeasonSupplement) {
    const priorSeason = MLB_SEASON - 1;
    if (needsPriorSeasonFallback) {
      console.log(
        `[${JOB_NAME}] pitcher ${pitcherId}: no ${MLB_SEASON} stats yet — falling back to ${priorSeason}`,
      );
    }
    [priorSeasonStats, priorRecentStats] = await Promise.all([
      fetchPitcherSeasonStats(pitcherId, priorSeason),
      fetchPitcherRecentStats(pitcherId, priorSeason),
    ]);
  }

  if (needsPriorSeasonFallback && priorSeasonStats && !isSeasonStatsEmpty(priorSeasonStats)) {
      effectiveSeasonStats = priorSeasonStats;
      effectiveRecentStats = priorRecentStats;
      statsSourceSeason = MLB_SEASON - 1;

      // On Opening Day, days_since_last_start from the prior season game log will be
      // ~175 days (last Oct start), which trips the EXTENDED_REST gate (>= 10 days)
      // in classifyLeash and blocks every K projection.
      // The gate is designed for mid-season IL returns — not season starts.
      // Opening Day starters pitch spring training ~4-6 days before Opening Day,
      // so we pin days_since_last_start to 5 when prior-season fallback is used.
      if (
        effectiveRecentStats.days_since_last_start == null ||
        effectiveRecentStats.days_since_last_start >= 10
      ) {
        effectiveRecentStats = { ...effectiveRecentStats, days_since_last_start: 5 };
      }
  }

  if (!needsPriorSeasonFallback && needsPriorSeasonSupplement && priorRecentStats) {
    supplementalSplits = priorRecentStats.allSplits ?? [];
  }

  // Prefer schedule-derived team abbreviation (matches odds_snapshot.home_team / away_team
  // used by run_mlb_model.js enrichment). Fall back to currentTeam.name if schedule didn't
  // include this pitcher (edge case).
  const team = teamFromSchedule ?? info.team;

  return {
    mlb_id: pitcherId,
    full_name: info.full_name,
    team,
    // pitcher_input_schema.md: handedness required for opp splits
    handedness: info.handedness,
    season: statsSourceSeason,
    era: effectiveSeasonStats.era,
    whip: effectiveSeasonStats.whip,
    k_per_9: effectiveSeasonStats.k_per_9,
    innings_pitched: effectiveSeasonStats.innings_pitched,
    // pitcher_input_schema.md: season_starts + season_k_pct required
    season_starts: effectiveSeasonStats.season_starts,
    season_k_pct: effectiveSeasonStats.season_k_pct,
    bb_pct: effectiveSeasonStats.bb_pct,
    hr_per_9: effectiveSeasonStats.hr_per_9,
    x_fip: effectiveSeasonStats.x_fip,
    siera: effectiveSeasonStats.siera,
    x_era: effectiveSeasonStats.x_era,
    recent_k_per_9: effectiveRecentStats.recent_k_per_9,
    recent_ip: effectiveRecentStats.recent_ip,
    // pitcher_input_schema.md: last_three_pitch_counts required — leash classification
    last_three_pitch_counts: effectiveRecentStats.last_three_pitch_counts, // JSON string, most recent first
    last_three_ip: effectiveRecentStats.last_three_ip,                    // JSON string, most recent first
    // pitcher_input_schema.md: k% windows for trend overlay
    k_pct_last_4_starts: effectiveRecentStats.k_pct_last_4_starts,
    k_pct_prior_4_starts: effectiveRecentStats.k_pct_prior_4_starts,
    // pitcher_input_schema.md: days_since_last_start required
    days_since_last_start: effectiveRecentStats.days_since_last_start,
    // il_status / il_return / role not derivable from MLB stats API — default safe values.
    // Populate via manual override or future transactions feed.
    il_status: 0,
    il_return: 0,
    role: 'starter',
    // season_swstr_pct / season_avg_velo require Statcast — stored null until pull_mlb_statcast is added
    season_swstr_pct: null,
    season_avg_velo: null,
    allSplits: effectiveRecentStats.allSplits ?? [],
    supplementalSplits,
  };
}

function ensurePitcherStatsTable(db) {
  // Schema aligned to pitcher_input_schema.md (WI-0596)
  db.exec(`
    CREATE TABLE IF NOT EXISTS mlb_pitcher_stats (
      id            TEXT PRIMARY KEY,
      mlb_id        INTEGER NOT NULL UNIQUE,
      full_name     TEXT,
      team          TEXT,
      season        INTEGER,
      era           REAL,
      whip          REAL,
      -- pitcher_input_schema.md: season_k9 required — halt if missing
      k_per_9       REAL,
      innings_pitched REAL,
      -- pitcher_input_schema.md: season_starts required — halt if missing
      season_starts   INTEGER,
      -- pitcher_input_schema.md: handedness required for opp splits
      handedness      TEXT,
      -- pitcher_input_schema.md: season_k_pct required for Block 3 trend
      season_k_pct    REAL,
      -- pitcher_input_schema.md: rolling_4start_k_pct required if >= 4 starts
      k_pct_last_4_starts  REAL,
      k_pct_prior_4_starts REAL,
      -- pitcher_input_schema.md: last_three_pitch_counts required — leash classification
      last_three_pitch_counts TEXT,  -- JSON array, most recent first
      last_three_ip           TEXT,  -- JSON array, most recent first
      -- pitcher_input_schema.md: days_since_last_start required
      days_since_last_start INTEGER,
      -- pitcher_input_schema.md: il_status / il_return required; defaulted — not in MLB stats API
      il_status  INTEGER NOT NULL DEFAULT 0,
      il_return  INTEGER NOT NULL DEFAULT 0,
      -- pitcher_input_schema.md: role required; defaulted — not in MLB stats API
      role       TEXT NOT NULL DEFAULT 'starter',
      -- Statcast fields: null until pull_mlb_statcast is added (WI-0596 notes)
      season_swstr_pct REAL,
      season_avg_velo  REAL,
      x_fip          REAL,
      siera          REAL,
      x_era          REAL,
      bb_pct         REAL,
      hr_per_9       REAL,
      recent_k_per_9  REAL,
      recent_ip       REAL,
      updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_mlb_pitcher_stats_mlb_id
    ON mlb_pitcher_stats (mlb_id);
    CREATE INDEX IF NOT EXISTS idx_mlb_pitcher_stats_team
    ON mlb_pitcher_stats (team);
  `);

  // Idempotent migrations for tables created before WI-0596
  const migrations = [
    'ALTER TABLE mlb_pitcher_stats ADD COLUMN season_starts INTEGER',
    'ALTER TABLE mlb_pitcher_stats ADD COLUMN handedness TEXT',
    'ALTER TABLE mlb_pitcher_stats ADD COLUMN season_k_pct REAL',
    'ALTER TABLE mlb_pitcher_stats ADD COLUMN k_pct_last_4_starts REAL',
    'ALTER TABLE mlb_pitcher_stats ADD COLUMN k_pct_prior_4_starts REAL',
    'ALTER TABLE mlb_pitcher_stats ADD COLUMN last_three_pitch_counts TEXT',
    'ALTER TABLE mlb_pitcher_stats ADD COLUMN last_three_ip TEXT',
    'ALTER TABLE mlb_pitcher_stats ADD COLUMN days_since_last_start INTEGER',
    "ALTER TABLE mlb_pitcher_stats ADD COLUMN il_status INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE mlb_pitcher_stats ADD COLUMN il_return INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE mlb_pitcher_stats ADD COLUMN role TEXT NOT NULL DEFAULT 'starter'",
    'ALTER TABLE mlb_pitcher_stats ADD COLUMN season_swstr_pct REAL',
    'ALTER TABLE mlb_pitcher_stats ADD COLUMN season_avg_velo REAL',
    'ALTER TABLE mlb_pitcher_stats ADD COLUMN x_fip REAL',
    'ALTER TABLE mlb_pitcher_stats ADD COLUMN siera REAL',
    'ALTER TABLE mlb_pitcher_stats ADD COLUMN x_era REAL',
    'ALTER TABLE mlb_pitcher_stats ADD COLUMN bb_pct REAL',
    'ALTER TABLE mlb_pitcher_stats ADD COLUMN hr_per_9 REAL',
  ];
  for (const sql of migrations) {
    try { db.exec(sql); } catch (_) { /* column already exists */ }
  }
}

function upsertPitcherRows(db, rows) {
  ensurePitcherStatsTable(db);
  const upsert = db.prepare(`
    INSERT INTO mlb_pitcher_stats (
      id,
      mlb_id,
      full_name,
      team,
      season,
      era,
      whip,
      k_per_9,
      innings_pitched,
      season_starts,
      handedness,
      season_k_pct,
      k_pct_last_4_starts,
      k_pct_prior_4_starts,
      last_three_pitch_counts,
      last_three_ip,
      days_since_last_start,
      il_status,
      il_return,
      role,
      season_swstr_pct,
      season_avg_velo,
      x_fip,
      siera,
      x_era,
      bb_pct,
      hr_per_9,
      recent_k_per_9,
      recent_ip,
      updated_at
    ) VALUES (
      ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now')
    )
    ON CONFLICT(mlb_id) DO UPDATE SET
      full_name               = excluded.full_name,
      team                    = excluded.team,
      season                  = excluded.season,
      era                     = excluded.era,
      whip                    = excluded.whip,
      k_per_9                 = excluded.k_per_9,
      innings_pitched         = excluded.innings_pitched,
      season_starts           = excluded.season_starts,
      handedness              = excluded.handedness,
      season_k_pct            = excluded.season_k_pct,
      k_pct_last_4_starts     = excluded.k_pct_last_4_starts,
      k_pct_prior_4_starts    = excluded.k_pct_prior_4_starts,
      last_three_pitch_counts = excluded.last_three_pitch_counts,
      last_three_ip           = excluded.last_three_ip,
      days_since_last_start   = excluded.days_since_last_start,
      il_status               = excluded.il_status,
      il_return               = excluded.il_return,
      role                    = excluded.role,
      season_swstr_pct        = excluded.season_swstr_pct,
      season_avg_velo         = excluded.season_avg_velo,
      x_fip                   = excluded.x_fip,
      siera                   = excluded.siera,
      x_era                   = excluded.x_era,
      bb_pct                  = excluded.bb_pct,
      hr_per_9                = excluded.hr_per_9,
      recent_k_per_9          = excluded.recent_k_per_9,
      recent_ip               = excluded.recent_ip,
      updated_at              = datetime('now')
  `);

  let upserted = 0;
  for (const row of rows) {
    upsert.run(
      uuidV4(),
      row.mlb_id,
      row.full_name,
      row.team,
      row.season,
      row.era,
      row.whip,
      row.k_per_9,
      row.innings_pitched,
      row.season_starts,
      row.handedness,
      row.season_k_pct,
      row.k_pct_last_4_starts,
      row.k_pct_prior_4_starts,
      row.last_three_pitch_counts,
      row.last_three_ip,
      row.days_since_last_start,
      row.il_status,
      row.il_return,
      row.role,
      row.season_swstr_pct,
      row.season_avg_velo,
      row.x_fip,
      row.siera,
      row.x_era,
      row.bb_pct,
      row.hr_per_9,
      row.recent_k_per_9,
      row.recent_ip,
    );
    upserted += 1;
  }
  return upserted;
}

async function pullMlbPitcherStats({
  jobKey = null,
  dryRun = false,
  date = todayDateString(),
} = {}) {
  const jobRunId = `job-${JOB_NAME}-${new Date().toISOString().split('.')[0]}-${uuidV4().slice(0, 8)}`;

  return withDbSafe(async () => {
    if (jobKey && !shouldRunJobKey(jobKey)) {
      console.log(`[${JOB_NAME}] Skipping (already succeeded or running): ${jobKey}`);
      return { success: true, skipped: true, jobRunId: null, jobKey };
    }

    let jobInserted = false;
    try {
      if (!dryRun) {
        insertJobRun(JOB_NAME, jobRunId, jobKey);
        jobInserted = true;
      }

      // Fetch schedule once; derive pitcher IDs and team abbreviation map from it.
      // The team abbreviation (e.g. "NYY") is the join key used by run_mlb_model.js
      // (WHERE team = odds_snapshot.home_team). Using currentTeam.name from /people/
      // can return null or a full name that doesn't match — so we source it here.
      const schedulePayload = await fetchSchedule(date);
      const pitcherIds = (() => {
        const ids = new Set();
        const dates = Array.isArray(schedulePayload.dates) ? schedulePayload.dates : [];
        for (const d of dates) {
          for (const game of (Array.isArray(d.games) ? d.games : [])) {
            const h = game?.teams?.home?.probablePitcher;
            const a = game?.teams?.away?.probablePitcher;
            if (h?.id) ids.add(Number(h.id));
            if (a?.id) ids.add(Number(a.id));
          }
        }
        return [...ids];
      })();
      const pitcherTeamMap = buildPitcherTeamMap(schedulePayload);
      console.log(`[${JOB_NAME}] date=${date} probable_pitchers=${pitcherIds.length}`);

      if (dryRun) {
        return {
          success: true,
          dryRun: true,
          date,
          pitcherCount: pitcherIds.length,
          pitcherIds,
        };
      }

      // Store gamePk map so settlement job can look up gamePk from game_date + team abbreviations
      const db = getDatabase();
      const gamePkCount = await storeGamePkMap(db, date);
      console.log(`[${JOB_NAME}] gamePkMap stored=${gamePkCount}`);

      const rows = await Promise.all(
        pitcherIds.map((id) =>
          fetchAllPitcherData(id, { teamFromSchedule: pitcherTeamMap.get(id) ?? null }).catch((err) => {
            console.warn(`[${JOB_NAME}] Failed to fetch data for pitcher ${id}: ${err.message}`);
            return null;
          }),
        ),
      );

      const validRows = rows.filter(Boolean);

      const upserted = upsertPitcherRows(db, validRows);

      // Also store raw per-start game logs for walk-forward backtesting
      let gameLogsCount = 0;
      for (const row of validRows) {
        if (row.allSplits && row.allSplits.length > 0) {
          gameLogsCount += upsertGameLogs(db, row.mlb_id, row.allSplits, row.season);
        }
        if (row.supplementalSplits && row.supplementalSplits.length > 0) {
          gameLogsCount += upsertGameLogs(
            db,
            row.mlb_id,
            row.supplementalSplits,
            MLB_SEASON - 1,
          );
        }
      }

      markJobRunSuccess(jobRunId, {
        date,
        pitcherCount: pitcherIds.length,
        upserted,
        gameLogsCount,
      });

      console.log(
        `[${JOB_NAME}] date=${date} pitcherCount=${pitcherIds.length} upserted=${upserted} gameLogs=${gameLogsCount}`,
      );

      return {
        success: true,
        date,
        pitcherCount: pitcherIds.length,
        upserted,
      };
    } catch (error) {
      if (!dryRun && jobInserted) {
        try {
          markJobRunFailure(jobRunId, error.message);
        } catch (markError) {
          console.error(`[${JOB_NAME}] Failed to record failure: ${markError.message}`);
        }
      }
      return { success: false, error: error.message };
    }
  });
}

function parseCliArgs(argv = process.argv.slice(2)) {
  const args = { dryRun: false, date: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--dry-run') {
      args.dryRun = true;
    } else if (arg === '--date' && argv[i + 1]) {
      args.date = argv[i + 1];
      i += 1;
    }
  }
  return args;
}

if (require.main === module) {
  const args = parseCliArgs();
  pullMlbPitcherStats({
    dryRun: args.dryRun,
    date: args.date || todayDateString(),
  })
    .then((result) => process.exit(result.success === false ? 1 : 0))
    .catch((error) => {
      console.error(`[${JOB_NAME}] Fatal:`, error.message);
      process.exit(1);
    });
}

module.exports = {
  JOB_NAME,
  todayDateString,
  fetchSchedule,
  fetchProbablePitcherIds,
  buildPitcherTeamMap,
  fetchPitcherSeasonStats,
  fetchPitcherRecentStats,
  fetchAllPitcherData,
  ensurePitcherStatsTable,
  upsertPitcherRows,
  ensureGameLogsTable,
  upsertGameLogs,
  ensureMlbGamePkMap,
  upsertGamePkMap,
  storeGamePkMap,
  parseCliArgs,
  pullMlbPitcherStats,
  // Exported for WI-0764 unit tests
  estimatePitcherSiera,
};
