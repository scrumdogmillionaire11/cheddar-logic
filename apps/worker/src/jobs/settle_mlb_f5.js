'use strict';

require('dotenv').config();
const assert = require('assert');
const { v4: uuidV4 } = require('uuid');
const {
  getDatabase,
  insertJobRun,
  markJobRunSuccess,
  markJobRunFailure,
  shouldRunJobKey,
  withDb,
} = require('@cheddar-logic/data');

const JOB_NAME = 'settle_mlb_f5';
const MLB_API_BASE = 'https://statsapi.mlb.com/api/v1';
const MIN_STABILITY_WINDOW_MS = 8000;

const SNAPSHOT_STATUS = {
  READY: 'READY',
  NOT_READY: 'NOT_READY',
  UNGRADABLE: 'UNGRADABLE',
};

const REASON_CODES = {
  HOME_LEADING: 'F5_ML_HOME_LEADING_AFTER_5',
  AWAY_LEADING: 'F5_ML_AWAY_LEADING_AFTER_5',
  TIED_PUSH: 'F5_ML_TIED_AFTER_5_PUSH',
  NOT_READY: 'F5_NOT_ELIGIBLE_YET',
  UNGRADABLE: 'F5_UNGRADABLE_GAME_STATE',
  UNVERIFIED: 'F5_SCORE_UNVERIFIED_STATE',
  SIDE_MISSING: 'F5_ML_SELECTION_SIDE_MISSING',
  SIDE_INVALID: 'F5_ML_INVALID_SELECTION_SIDE',
  CORRECTION: 'F5_CORRECTION_DETECTED',
  TOTAL_OVER: 'F5_TOTAL_OVER',
  TOTAL_UNDER: 'F5_TOTAL_UNDER',
  TOTAL_PUSH: 'F5_TOTAL_PUSH',
};

/**
 * Fetch inning-by-inning linescore for a completed game and sum innings 1-5.
 * Returns null if the game is not yet 5 innings complete or API unavailable.
 */
async function fetchF5Total(gamePk) {
  const payload = await fetchMlbLivePayload(gamePk);
  if (!payload) return null;
  const linescore = payload?.liveData?.linescore ?? payload?.linescore;
  if (!linescore || !Array.isArray(linescore.innings)) return null;
  const first5 = linescore.innings.slice(0, 5);
  if (first5.length < 5) return null;
  return first5.reduce((sum, inning) => {
    return sum + (inning?.home?.runs ?? 0) + (inning?.away?.runs ?? 0);
  }, 0);
}

async function fetchMlbLivePayload(gamePk) {
  const urls = [
    `https://statsapi.mlb.com/api/v1.1/game/${gamePk}/feed/live`,
    `${MLB_API_BASE}/game/${gamePk}/feed/live`,
  ];
  for (const url of urls) {
    try {
      const res = await fetch(url, {
        headers: { 'user-agent': 'cheddar-logic-worker' },
      });
      if (!res.ok) continue;
      return await res.json();
    } catch {
      // try next URL
    }
  }
  return null;
}

async function fetchF5GameState(gamePk, snapshotFetchedAt = new Date().toISOString()) {
  const payload = await fetchMlbLivePayload(gamePk);
  if (!payload) return null;
  return buildF5GameState(payload, snapshotFetchedAt);
}

function buildF5GameState(payload, snapshotFetchedAt = new Date().toISOString()) {
  const linescore = payload?.liveData?.linescore ?? payload?.linescore;
  const innings = Array.isArray(linescore?.innings) ? linescore.innings : [];
  const currentPlay = payload?.liveData?.plays?.currentPlay;
  const abstractGameState =
    payload?.gameData?.status?.abstractGameState ??
    payload?.gameData?.status?.codedGameState ??
    payload?.status ??
    'In Progress';

  return {
    current_inning: toFiniteNumberOrNull(linescore?.currentInning) ?? innings.length,
    is_bottom_inning: linescore?.isTopInning === false,
    home_runs: sumF5SideRuns(innings, 'home'),
    away_runs: sumF5SideRuns(innings, 'away'),
    home_runs_through_4: sumSideRuns(innings, 'home', 4),
    away_runs_through_5: sumSideRuns(innings, 'away', 5),
    current_outs: toFiniteNumberOrNull(linescore?.outs),
    abstract_game_state: String(abstractGameState || ''),
    partial_play_flag:
      String(abstractGameState || '').toLowerCase() === 'in progress' &&
      currentPlay?.about?.isComplete === false,
    last_event_timestamp:
      currentPlay?.about?.endTime ??
      currentPlay?.about?.startTime ??
      payload?.metaData?.timeStamp ??
      null,
    snapshot_fetched_at: snapshotFetchedAt,
  };
}

function sumF5SideRuns(innings, side) {
  return sumSideRuns(innings, side, 5, {
    treatMissingLastHomeAsZero: side === 'home',
  });
}

function sumSideRuns(innings, side, count, { treatMissingLastHomeAsZero = false } = {}) {
  if (!Array.isArray(innings) || innings.length < count) return null;
  let total = 0;
  for (let i = 0; i < count; i += 1) {
    const inning = innings[i];
    const rawRuns = inning?.[side]?.runs;
    if (rawRuns == null) {
      if (treatMissingLastHomeAsZero && side === 'home' && i === count - 1) continue;
      return null;
    }
    const runs = Number(rawRuns);
    if (!Number.isFinite(runs)) return null;
    total += runs;
  }
  return total;
}

function resolveF5Snapshot(gameState) {
  if (!gameState || typeof gameState !== 'object') {
    return ungradableSnapshot(gameState, REASON_CODES.UNGRADABLE);
  }

  const homeRuns = toFiniteNumberOrNull(gameState.home_runs);
  const awayRuns = toFiniteNumberOrNull(gameState.away_runs);
  const currentInning = toFiniteNumberOrNull(gameState.current_inning);
  const currentOuts = toFiniteNumberOrNull(gameState.current_outs);
  const homeRunsThrough4 = toFiniteNumberOrNull(gameState.home_runs_through_4) ?? homeRuns;
  const awayRunsThrough5 = toFiniteNumberOrNull(gameState.away_runs_through_5) ?? awayRuns;
  const abstractState = String(gameState.abstract_game_state || '').toLowerCase();

  if (['suspended', 'cancelled', 'canceled'].includes(abstractState)) {
    return ungradableSnapshot(gameState, REASON_CODES.UNGRADABLE);
  }

  if (currentInning !== null && currentInning < 5) {
    return {
      status: SNAPSHOT_STATUS.NOT_READY,
      home_runs: homeRuns,
      away_runs: awayRuns,
      is_verified: false,
      reason_code: REASON_CODES.NOT_READY,
    };
  }

  if (homeRuns === null || awayRuns === null) {
    return {
      status: SNAPSHOT_STATUS.UNGRADABLE,
      home_runs: homeRuns,
      away_runs: awayRuns,
      is_verified: false,
      reason_code: REASON_CODES.UNGRADABLE,
    };
  }

  const topFiveComplete =
    currentInning !== null &&
    (currentInning > 5 ||
      (currentInning === 5 && (gameState.is_bottom_inning === true || currentOuts === 3)));
  const fiveComplete =
    currentInning !== null &&
    (currentInning > 5 ||
      (currentInning === 5 && gameState.is_bottom_inning === true && currentOuts === 3));
  const homeLeadingAtFourAndHalf =
    topFiveComplete &&
    homeRunsThrough4 !== null &&
    awayRunsThrough5 !== null &&
    homeRunsThrough4 > awayRunsThrough5;
  const wouldBeReady = fiveComplete || homeLeadingAtFourAndHalf;
  const resolvedHomeRuns = fiveComplete
    ? homeRuns
    : homeLeadingAtFourAndHalf
      ? homeRunsThrough4
      : homeRuns;
  const resolvedAwayRuns = fiveComplete
    ? awayRuns
    : homeLeadingAtFourAndHalf
      ? awayRunsThrough5
      : awayRuns;

  if (!wouldBeReady) {
    return {
      status: SNAPSHOT_STATUS.NOT_READY,
      home_runs: homeRuns,
      away_runs: awayRuns,
      is_verified: false,
      reason_code: REASON_CODES.NOT_READY,
    };
  }

  const isVerified =
    homeRuns !== null &&
    awayRuns !== null &&
    topFiveComplete &&
    gameState.partial_play_flag !== true &&
    hasStableSnapshotWindow(gameState.snapshot_fetched_at, gameState.last_event_timestamp);

  if (!isVerified) {
    return {
      status: SNAPSHOT_STATUS.UNGRADABLE,
      home_runs: resolvedHomeRuns,
      away_runs: resolvedAwayRuns,
      is_verified: false,
      reason_code: REASON_CODES.UNVERIFIED,
    };
  }

  return {
    status: SNAPSHOT_STATUS.READY,
    home_runs: resolvedHomeRuns,
    away_runs: resolvedAwayRuns,
    is_verified: true,
    reason_code: null,
  };
}

function ungradableSnapshot(gameState, reasonCode) {
  return {
    status: SNAPSHOT_STATUS.UNGRADABLE,
    home_runs: toFiniteNumberOrNull(gameState?.home_runs),
    away_runs: toFiniteNumberOrNull(gameState?.away_runs),
    is_verified: false,
    reason_code: reasonCode,
  };
}

function hasStableSnapshotWindow(snapshotFetchedAt, lastEventTimestamp) {
  const fetchedMs = Date.parse(snapshotFetchedAt);
  const eventMs = Date.parse(lastEventTimestamp);
  return Number.isFinite(fetchedMs) &&
    Number.isFinite(eventMs) &&
    fetchedMs - eventMs > MIN_STABILITY_WINDOW_MS;
}

/**
 * Grade an F5 card: compare OVER/UNDER prediction vs actual total vs line.
 * Returns 'win', 'loss', 'push', or null (if unsettleable).
 */
function gradeF5Card(prediction, line, actualTotal) {
  if (actualTotal === null || line === null) return null;
  const edge = actualTotal - line;
  if (Math.abs(edge) < 0.05) return 'push'; // within rounding
  if (prediction === 'OVER') return actualTotal > line ? 'win' : 'loss';
  if (prediction === 'UNDER') return actualTotal < line ? 'win' : 'loss';
  return null; // PASS cards and unknown predictions are not settled
}

function normalizeOutcomeToken(outcome) {
  const token = String(outcome || '').trim().toLowerCase();
  if (token === 'won') return 'win';
  if (token === 'lost') return 'loss';
  if (token === 'win' || token === 'loss' || token === 'push' || token === 'no_contest') {
    return token;
  }
  return null;
}

function normalizeF5MlSelection(card) {
  const payload = card.payload ?? parseJsonObject(card.payload_data);
  const rawSide =
    card.selection ??
    payload?.selection?.side ??
    payload?.market_context?.selection_side ??
    payload?.canonical_envelope_v2?.selection_side ??
    payload?.decision_v2?.selection_side ??
    null;

  if (rawSide == null || String(rawSide).trim() === '') return 'INVALID';
  const token = String(rawSide).trim().toUpperCase();
  if (['HOME', 'H'].includes(token)) return 'HOME';
  if (['AWAY', 'A'].includes(token)) return 'AWAY';

  const homeTeam = normalizeTeamToken(card.home_team);
  const awayTeam = normalizeTeamToken(card.away_team);
  const sideTeam = normalizeTeamToken(rawSide);
  if (sideTeam && homeTeam && sideTeam === homeTeam && sideTeam !== awayTeam) return 'HOME';
  if (sideTeam && awayTeam && sideTeam === awayTeam && sideTeam !== homeTeam) return 'AWAY';
  return 'INVALID';
}

function isF5TotalCard(card) {
  return card?.card_type === 'mlb-f5';
}

function isF5MlCard(card) {
  return card?.card_type === 'mlb-f5-ml';
}

function assertF5MarketExclusion(card) {
  assert(
    !(isF5TotalCard(card) && isF5MlCard(card)),
    'card classified as both F5 total and F5 ML - payload classification error',
  );
}

function gradeF5MlCard(selection, snapshot) {
  if (snapshot.home_runs > snapshot.away_runs) {
    return {
      result: selection === 'HOME' ? 'win' : 'loss',
      reasonCode: REASON_CODES.HOME_LEADING,
    };
  }
  if (snapshot.away_runs > snapshot.home_runs) {
    return {
      result: selection === 'AWAY' ? 'win' : 'loss',
      reasonCode: REASON_CODES.AWAY_LEADING,
    };
  }
  return { result: 'push', reasonCode: REASON_CODES.TIED_PUSH };
}

function settleF5Total(card, snapshot) {
  if (snapshot.status === SNAPSHOT_STATUS.NOT_READY) {
    return { action: 'pending', reasonCode: REASON_CODES.NOT_READY };
  }
  if (snapshot.status === SNAPSHOT_STATUS.UNGRADABLE) {
    return {
      action: 'settle',
      result: 'no_contest',
      reasonCode: snapshot.reason_code || REASON_CODES.UNGRADABLE,
    };
  }

  const payload = card.payload ?? parseJsonObject(card.payload_data);
  const prediction = payload?.prediction;
  const line =
    payload?.f5_market_line?.line ??
    payload?.market?.line ??
    payload?.f5_line ??
    card.line ??
    null;
  if (!prediction || prediction === 'PASS' || line === null) {
    return { action: 'skip', reasonCode: 'F5_TOTAL_UNGRADEABLE_INPUT' };
  }

  const actualTotal = snapshot.home_runs + snapshot.away_runs;
  const outcome = normalizeOutcomeToken(gradeF5Card(prediction, line, actualTotal));
  if (!outcome) return { action: 'failed', reasonCode: 'F5_TOTAL_UNGRADEABLE_INPUT' };
  const reasonCode =
    outcome === 'push'
      ? REASON_CODES.TOTAL_PUSH
      : prediction === 'OVER'
        ? REASON_CODES.TOTAL_OVER
        : REASON_CODES.TOTAL_UNDER;
  return {
    action: 'settle',
    result: outcome,
    reasonCode,
    actualF5: actualTotal,
    marketLineSource: payload?.f5_market_line?.source ?? 'original',
  };
}

function settleF5Ml(card, snapshot) {
  const payload = card.payload ?? parseJsonObject(card.payload_data);
  const explicitSide =
    card.selection ??
    payload?.selection?.side ??
    payload?.market_context?.selection_side ??
    payload?.canonical_envelope_v2?.selection_side ??
    payload?.decision_v2?.selection_side ??
    null;
  if (explicitSide == null || String(explicitSide).trim() === '') {
    return { action: 'failed', reasonCode: REASON_CODES.SIDE_MISSING };
  }

  const selection = normalizeF5MlSelection(card);
  if (selection === 'INVALID') {
    return { action: 'failed', reasonCode: REASON_CODES.SIDE_INVALID };
  }
  if (snapshot.status === SNAPSHOT_STATUS.NOT_READY) {
    return { action: 'pending', reasonCode: REASON_CODES.NOT_READY };
  }
  if (snapshot.status === SNAPSHOT_STATUS.UNGRADABLE) {
    return {
      action: 'settle',
      result: 'no_contest',
      reasonCode: snapshot.reason_code || REASON_CODES.UNGRADABLE,
    };
  }

  const graded = gradeF5MlCard(selection, snapshot);
  return {
    action: 'settle',
    result: graded.result,
    reasonCode: graded.reasonCode,
    selection,
  };
}

function detectFeedCorrection(card, snapshot) {
  if (snapshot.status !== SNAPSHOT_STATUS.READY || !card.result) return false;
  let latest = null;
  if (isF5MlCard(card)) {
    const selection = normalizeF5MlSelection(card);
    if (selection === 'INVALID') return false;
    latest = gradeF5MlCard(selection, snapshot).result;
  } else if (isF5TotalCard(card)) {
    latest = settleF5Total(card, snapshot).result;
  }
  if (latest && latest !== card.result) {
    console.warn(
      `  [${JOB_NAME}] ${card.game_id}: ${REASON_CODES.CORRECTION} result_id=${card.result_id} stored=${card.result} latest=${latest}`,
    );
    return true;
  }
  return false;
}

async function settleMlbF5({ jobKey = null, dryRun = false } = {}) {
  const jobRunId = `job-${JOB_NAME}-${new Date().toISOString().split('.')[0]}-${uuidV4().slice(0, 8)}`;

  return withDb(async () => {
    if (jobKey && !shouldRunJobKey(jobKey)) {
      return { success: true, skipped: true, jobRunId: null };
    }

    let jobInserted = false;
    try {
      if (!dryRun) {
        insertJobRun(JOB_NAME, jobRunId, jobKey);
        jobInserted = true;
      }

      const db = getDatabase();

      // Find MLB F5 cards where game is likely complete (T+4h). Settled rows are
      // included only for correction detection; pending rows are the only writes.
      const cutoffTime = new Date(Date.now() - 4 * 60 * 60 * 1000).toISOString();
      const pendingF5 = db.prepare(`
        SELECT
          cr.id as result_id,
          cr.card_id,
          cr.game_id,
          cr.status,
          cr.result,
          cr.card_type,
          cr.selection,
          cr.line,
          cr.primary_reason_code,
          cp.payload_data,
          g.game_time_utc,
          g.home_team,
          g.away_team,
          gr.metadata as game_result_meta
        FROM card_results cr
        JOIN card_payloads cp ON cr.card_id = cp.id
        JOIN games g ON cr.game_id = g.game_id
        LEFT JOIN game_results gr ON gr.game_id = cr.game_id AND gr.status = 'final'
        WHERE cr.sport = 'mlb'
          AND cr.status IN ('pending', 'settled')
          AND cr.card_type IN ('mlb-f5', 'mlb-f5-ml')
          AND g.game_time_utc < ?
        ORDER BY
          CASE cr.status WHEN 'pending' THEN 0 ELSE 1 END,
          g.game_time_utc DESC,
          cr.id ASC
        LIMIT 50
      `).all(cutoffTime);

      if (pendingF5.length === 0) {
        if (!dryRun) markJobRunSuccess(jobRunId, { settled: 0, failed: 0 });
        console.log(`[${JOB_NAME}] settled=0 failed=0`);
        return { success: true, jobRunId, settled: 0, failed: 0 };
      }

      let settled = 0;
      let failed = 0;
      let pending = 0;
      let corrections = 0;
      const snapshotStatus = { READY: 0, NOT_READY: 0, UNGRADABLE: 0 };
      const resultDistribution = { win: 0, loss: 0, push: 0, no_contest: 0 };

      for (const row of pendingF5) {
        const card = {
          ...row,
          payload: parseJsonObject(row.payload_data),
        };

        try {
          assertF5MarketExclusion(card);

          const gameState = await resolveCardGameState(db, card);
          if (!gameState) {
            console.warn(`  [${JOB_NAME}] ${card.game_id}: no F5 game state available`);
            failed++;
            continue;
          }
          const snapshot = resolveF5Snapshot(gameState);
          cacheF5Snapshot(db, card, snapshot, dryRun);
          snapshotStatus[snapshot.status] = (snapshotStatus[snapshot.status] || 0) + 1;

          if (card.status === 'settled') {
            assert(card.result !== null, 'settled card has null result - data corruption');
            if (detectFeedCorrection(card, snapshot)) corrections++;
            continue;
          }

          let decision = null;
          if (isF5TotalCard(card)) {
            decision = settleF5Total(card, snapshot);
          } else if (isF5MlCard(card)) {
            decision = settleF5Ml(card, snapshot);
          } else {
            continue;
          }

          if (decision.action === 'pending') {
            pending++;
            continue;
          }
          if (decision.action === 'skip') {
            continue;
          }
          if (decision.action === 'failed') {
            writePendingReasonCode(db, card, decision.reasonCode, dryRun);
            failed++;
            console.warn(
              `  [${JOB_NAME}] ${card.game_id}: ${decision.reasonCode} result_id=${card.result_id}`,
            );
            continue;
          }

          if (!dryRun) {
            const writeResult = db.prepare(`
              UPDATE card_results SET
                status = 'settled',
                result = ?,
                primary_reason_code = ?,
                settled_at = datetime('now'),
                updated_at = datetime('now')
              WHERE id = ?
                AND status = 'pending'
            `).run(decision.result, decision.reasonCode, card.result_id);

            if (Number(writeResult?.changes || 0) === 0) {
              console.log(
                `  [${JOB_NAME}] ${card.game_id}: skipped idempotent terminal write (result_id=${card.result_id} already terminal)`,
              );
              continue;
            }
          }

          resultDistribution[decision.result] = (resultDistribution[decision.result] || 0) + 1;
          settled++;
          console.log(
            `  [${JOB_NAME}] ${card.game_id}: ${card.card_type} snapshot=${snapshot.status} home=${snapshot.home_runs} away=${snapshot.away_runs} result=${decision.result} reason=${decision.reasonCode}`,
          );
        } catch (err) {
          console.warn(`  [${JOB_NAME}] ${card.game_id}: ${err.message}`);
          failed++;
        }
      }

      const summary = {
        settled,
        failed,
        pending,
        corrections,
        snapshot_status: snapshotStatus,
        result_distribution: resultDistribution,
      };
      if (!dryRun) markJobRunSuccess(jobRunId, summary);
      console.log(`[${JOB_NAME}] ${JSON.stringify(summary)}`);
      return { success: true, jobRunId, ...summary };
    } catch (err) {
      if (!dryRun && jobInserted) {
        try {
          markJobRunFailure(jobRunId, err.message);
        } catch {}
      }
      return { success: false, error: err.message };
    }
  });
}

async function resolveCardGameState(db, card) {
  const cached = readCachedF5Snapshot(card);
  if (cached) return cached;

  const gamePk = resolveMlbGamePk(db, card);
  if (!gamePk) {
    console.warn(
      `  [${JOB_NAME}] ${card.game_id}: no gamePk in MLB game maps for ${describeGamePkLookup(card)}`,
    );
    return null;
  }

  return fetchF5GameState(gamePk);
}

function resolveMlbGamePk(db, card) {
  for (const candidate of buildGamePkLookupCandidates(card)) {
    if (!candidate.key || !sqliteTableExists(db, candidate.table)) continue;
    const row = db
      .prepare(`SELECT game_pk FROM ${candidate.table} WHERE game_pk_key = ?`)
      .get(candidate.key);
    const gamePk = toFiniteNumberOrNull(row?.game_pk);
    if (gamePk !== null) return gamePk;
  }
  return null;
}

function buildGamePkLookupCandidates(card) {
  const gameDate = card.game_time_utc?.slice(0, 10);
  const scheduledStartKey = card.game_time_utc && card.home_team && card.away_team
    ? `${card.game_time_utc}|${card.home_team}|${card.away_team}`
    : null;
  const matchupDateKey = gameDate && card.home_team && card.away_team
    ? `${gameDate}|${card.home_team}|${card.away_team}`
    : null;

  return [
    { table: 'mlb_game_pk_map', key: card.game_id },
    { table: 'mlb_probable_starter_map', key: scheduledStartKey },
    { table: 'mlb_game_pk_map', key: matchupDateKey },
  ];
}

function describeGamePkLookup(card) {
  return buildGamePkLookupCandidates(card)
    .map((candidate) => `${candidate.table}:${candidate.key ?? 'missing-key'}`)
    .join(', ');
}

function sqliteTableExists(db, tableName) {
  const row = db
    .prepare("SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(tableName);
  return Boolean(row?.ok);
}

function readCachedF5Snapshot(card) {
  const meta = parseJsonObject(card.game_result_meta);
  if (!meta) return null;
  const snapshot = meta.f5_snapshot;
  if (snapshot && typeof snapshot === 'object') return snapshot;
  if (meta.f5_home_runs != null && meta.f5_away_runs != null) {
    const fetchedAt = new Date().toISOString();
    return {
      current_inning: 6,
      is_bottom_inning: false,
      home_runs: Number(meta.f5_home_runs),
      away_runs: Number(meta.f5_away_runs),
      current_outs: 3,
      abstract_game_state: 'Final',
      partial_play_flag: false,
      last_event_timestamp: new Date(Date.now() - MIN_STABILITY_WINDOW_MS - 1000).toISOString(),
      snapshot_fetched_at: fetchedAt,
    };
  }
  if (meta.f5_total != null) {
    return null;
  }
  return null;
}

function cacheF5Snapshot(db, card, snapshot, dryRun) {
  if (dryRun || snapshot.status !== SNAPSHOT_STATUS.READY) return;
  const actualF5 = snapshot.home_runs + snapshot.away_runs;
  db.prepare(`
    UPDATE game_results SET
      metadata = json_set(
        COALESCE(metadata, '{}'),
        '$.f5_total', ?,
        '$.f5_home_runs', ?,
        '$.f5_away_runs', ?
      ),
      updated_at = datetime('now')
    WHERE game_id = ?
  `).run(actualF5, snapshot.home_runs, snapshot.away_runs, card.game_id);
}

function writePendingReasonCode(db, card, reasonCode, dryRun) {
  if (dryRun || !reasonCode) return;
  db.prepare(`
    UPDATE card_results SET
      primary_reason_code = ?,
      updated_at = datetime('now')
    WHERE id = ?
      AND status = 'pending'
  `).run(reasonCode, card.result_id);
}

function parseJsonObject(value) {
  if (!value) return null;
  if (typeof value === 'object') return value;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function toFiniteNumberOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function normalizeTeamToken(value) {
  return String(value || '')
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');
}

function parseCliArgs(argv = process.argv.slice(2)) {
  const args = { dryRun: false };
  for (const arg of argv) {
    if (arg === '--dry-run') args.dryRun = true;
  }
  return args;
}

if (require.main === module) {
  const args = parseCliArgs();
  settleMlbF5({ dryRun: args.dryRun })
    .then((r) => process.exit(r.success ? 0 : 1))
    .catch((err) => {
      console.error(err.message);
      process.exit(1);
    });
}

module.exports = {
  JOB_NAME,
  MIN_STABILITY_WINDOW_MS,
  REASON_CODES,
  SNAPSHOT_STATUS,
  settleMlbF5,
  fetchF5Total,
  fetchF5GameState,
  buildF5GameState,
  resolveF5Snapshot,
  normalizeF5MlSelection,
  isF5TotalCard,
  isF5MlCard,
  gradeF5Card,
  gradeF5MlCard,
  parseCliArgs,
};
