'use strict';

require('dotenv').config();
const { v4: uuidV4 } = require('uuid');
const {
  getDatabase,
  insertJobRun,
  markJobRunSuccess,
  markJobRunFailure,
  hasSuccessfulJobRun,
  shouldRunJobKey,
  withDb,
  getUnsettledProjectionCards,
  setProjectionActualResult,
  batchInsertProjectionProxyEvals,
} = require('@cheddar-logic/data');
const { buildProjectionProxyMarketRows, CARD_TYPE_TO_FAMILY, resolveMoneylineConfidenceBucket } = require('../audit/projection_evaluator');
const { fetchNhlSettlementSnapshot, resolveNhlFullGamePlayerShots } = require('./nhl-settlement-source');
const { fetchF5Total, fetchF5GameState, resolveF5Snapshot, resolveMlbGamePk } = require('./settle_mlb_f5');

const JOB_NAME = 'settle_projections';
const PITCHER_K_PROJECTION_SETTLEMENT_CODES = Object.freeze({
  NO_GAME_PK: 'PROJECTION_SETTLEMENT_NO_GAME_PK',
  NO_PLAYER_MATCH: 'PROJECTION_SETTLEMENT_NO_PLAYER_MATCH',
});
const PROXY_EVAL_BACKFILL_CARD_TYPES = new Set(['nhl-pace-1p', 'mlb-f5', 'mlb-f5-ml']);
const MLB_F5_PROXY_CLEAR_ZONE = Object.freeze({
  UNDER_LINE: 3.5,
  OVER_LINE: 4.5,
});

function parseJsonObject(value) {
  if (!value) return {};
  if (typeof value === 'object') return value;
  if (typeof value !== 'string') return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function toFiniteNumberOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeProbability(value) {
  const parsed = toFiniteNumberOrNull(value);
  if (parsed === null) return null;
  const probability = parsed > 1 && parsed <= 100 ? parsed / 100 : parsed;
  return probability >= 0 && probability <= 1 ? probability : null;
}

function normalizeMoneylineSide(value) {
  const token = String(value || '').trim().toUpperCase();
  if (token === 'HOME' || token === 'H') return 'HOME';
  if (token === 'AWAY' || token === 'A') return 'AWAY';
  return null;
}

function resolveF5MlSelectedSide(payload = {}) {
  return normalizeMoneylineSide(
    payload?.selection?.side ??
      payload?.play?.selection?.side ??
      payload?.market_context?.selection_side ??
      payload?.canonical_envelope_v2?.selection_side ??
      payload?.decision_v2?.selection_side ??
      payload?.prediction,
  );
}

function resolveF5MlSelectedWinProbability(payload = {}, selectedSide = null) {
  const selectedProbability = normalizeProbability(
    payload?.projection_accuracy?.win_probability ??
      payload?.win_probability ??
      payload?.p_fair ??
      payload?.fair_prob ??
      payload?.model_prob,
  );
  if (selectedProbability !== null) return selectedProbability;

  const homeProbability = normalizeProbability(
    payload?.projection?.projected_win_prob_home ??
      payload?.drivers?.[0]?.projected_win_prob_home ??
      payload?.drivers?.[0]?.win_prob_home,
  );
  if (homeProbability === null) return null;
  if (selectedSide === 'HOME') return homeProbability;
  if (selectedSide === 'AWAY') return Math.round((1 - homeProbability) * 1_000_000) / 1_000_000;
  return null;
}

function resolveF5MlActualForSelectedSide(winner, selectedSide) {
  const normalizedWinner = normalizeMoneylineSide(winner);
  const normalizedSide = normalizeMoneylineSide(selectedSide);
  if (String(winner || '').toUpperCase() === 'PUSH') return 0.5;
  if (!normalizedWinner || !normalizedSide) return null;
  return normalizedWinner === normalizedSide ? 1 : 0;
}

function classifyMlbF5ProxySettlementWindow(projectionValue) {
  const projection = toFiniteNumberOrNull(projectionValue);
  if (projection === null) {
    return { gradingMode: 'INVALID', proxyLine: null, recommendedSide: null };
  }
  if (projection < MLB_F5_PROXY_CLEAR_ZONE.UNDER_LINE) {
    return {
      gradingMode: 'OFFICIAL',
      proxyLine: MLB_F5_PROXY_CLEAR_ZONE.UNDER_LINE,
      recommendedSide: 'UNDER',
    };
  }
  if (projection > MLB_F5_PROXY_CLEAR_ZONE.OVER_LINE) {
    return {
      gradingMode: 'OFFICIAL',
      proxyLine: MLB_F5_PROXY_CLEAR_ZONE.OVER_LINE,
      recommendedSide: 'OVER',
    };
  }
  return { gradingMode: 'TRACK_ONLY', proxyLine: null, recommendedSide: null };
}

function buildOfficialMlbF5ProxyRow(card, projectionValue, actualF5) {
  const projection = toFiniteNumberOrNull(projectionValue);
  const actualValue = toFiniteNumberOrNull(actualF5);
  const classification = classifyMlbF5ProxySettlementWindow(projection);
  if (projection === null || actualValue === null || classification.gradingMode !== 'OFFICIAL') {
    return null;
  }

  const edgeVsLine = Math.round((projection - classification.proxyLine) * 10_000) / 10_000;
  const absEdge = Math.abs(edgeVsLine);
  let tier = 'STRONG';
  let confidenceBucket = 'LARGE';
  if (absEdge < 0.5) {
    tier = 'LEAN';
    confidenceBucket = 'SMALL';
  } else if (absEdge < 0.75) {
    tier = 'PLAY';
    confidenceBucket = 'MEDIUM';
  }

  const isWin =
    classification.recommendedSide === 'OVER'
      ? actualValue > classification.proxyLine
      : actualValue < classification.proxyLine;
  const hitFlag = isWin ? 1 : 0;
  const tierScoreWeight = tier === 'LEAN' ? 1 : tier === 'PLAY' ? 1.5 : 2;

  return {
    card_id: card.card_id,
    game_id: card.game_id,
    game_date: card.game_time_utc?.slice(0, 10),
    sport: card.sport,
    card_family: CARD_TYPE_TO_FAMILY[card.card_type],
    proj_value: projection,
    actual_value: actualValue,
    proxy_line: classification.proxyLine,
    edge_vs_line: edgeVsLine,
    recommended_side: classification.recommendedSide,
    tier,
    confidence_bucket: confidenceBucket,
    agreement_group: 'DIRECT_SELECTION',
    graded_result: isWin ? 'WIN' : 'LOSS',
    hit_flag: hitFlag,
    tier_score: isWin ? tierScoreWeight : -tierScoreWeight,
    consensus_bonus: 0,
  };
}

function setProjectionSettlementMetadata(db, cardId, { code, message }) {
  const row = db
    .prepare(
      `
      SELECT id, metadata
      FROM card_results
      WHERE card_id = ?
        AND status = 'pending'
      ORDER BY id DESC
      LIMIT 1
    `,
    )
    .get(cardId);

  if (!row?.id) return false;

  const metadata = parseJsonObject(row.metadata);
  metadata.projection_settlement = {
    code,
    message,
    final: true,
    at: new Date().toISOString(),
  };

  db.prepare(
    `
    UPDATE card_results
    SET metadata = ?
    WHERE id = ?
      AND status = 'pending'
  `,
  ).run(JSON.stringify(metadata), row.id);

  return true;
}

function getStoredActualResult(card) {
  return parseJsonObject(card?.actual_result);
}

function insertProjectionProxyRows(db, card, payload, actualResult) {
  if (!PROXY_EVAL_BACKFILL_CARD_TYPES.has(card?.card_type)) return 0;

  let proxyRows = [];

  if (card.card_type === 'nhl-pace-1p') {
    const goals1p = toFiniteNumberOrNull(actualResult?.goals_1p);
    if (goals1p === null) return 0;
    const nhlProjection =
      payload?.projected_total ??
      payload?.projection?.total ??
      payload?.drivers?.[0]?.projected ??
      null;
    proxyRows = buildProjectionProxyMarketRows({
      card_id: card.card_id,
      game_id: card.game_id,
      game_date: card.game_time_utc?.slice(0, 10),
      sport: card.sport,
      card_family: CARD_TYPE_TO_FAMILY[card.card_type],
      model_projection: nhlProjection,
      actual_result: JSON.stringify({ goals_1p: goals1p }),
    });
  }

  if (card.card_type === 'mlb-f5') {
    const runsF5 = toFiniteNumberOrNull(actualResult?.runs_f5);
    if (runsF5 === null) return 0;
    const projectionValue =
      payload?.projection?.projected_total ??
      payload?.projected_total ??
      null;
    const officialRow = buildOfficialMlbF5ProxyRow(card, projectionValue, runsF5);
    proxyRows = officialRow ? [officialRow] : [];
  }

  if (card.card_type === 'mlb-f5-ml') {
    const selectedSide = actualResult?.selected_side ?? resolveF5MlSelectedSide(payload);
    const actualSelectedSide = toFiniteNumberOrNull(actualResult?.f5_ml_actual);
    const winner = actualResult?.f5_winner ?? null;
    const selectedWinProbability = resolveF5MlSelectedWinProbability(payload, selectedSide);
    if (selectedWinProbability === null || actualSelectedSide === null) return 0;
    proxyRows = buildProjectionProxyMarketRows({
      card_id: card.card_id,
      game_id: card.game_id,
      game_date: card.game_time_utc?.slice(0, 10),
      sport: card.sport,
      card_family: CARD_TYPE_TO_FAMILY[card.card_type],
      model_projection: selectedWinProbability,
      actual_value: actualSelectedSide,
      selected_side: selectedSide,
      confidence_bucket: resolveMoneylineConfidenceBucket({ payload }),
      confidence_score: payload?.confidence_score,
      actual_result: JSON.stringify({
        f5_ml_actual: actualSelectedSide,
        f5_winner: winner,
        selected_side: selectedSide,
      }),
    });
  }

  if (proxyRows.length === 0) return 0;

  try {
    batchInsertProjectionProxyEvals(db, proxyRows);
  } catch (proxyErr) {
    console.error('[settle_projections] proxy eval insert failed', card.card_id, proxyErr?.message);
    return 0;
  }
  return proxyRows.length;
}

/**
 * Resolve the NHL Gamecenter ID from the game_id_map table or by treating
 * a pure-numeric canonical game_id as the native NHL ID (same logic as
 * settle_game_results.js resolveNhlGamecenterId).
 *
 * @param {object} db - better-sqlite3 DB instance
 * @param {string} gameId - canonical game_id
 * @returns {string|null}
 */
function resolveNhlGamecenterId(db, gameId) {
  // Try explicit mapping first
  try {
    const row = db
      .prepare(
        `SELECT external_game_id
         FROM game_id_map
         WHERE sport = 'nhl'
           AND provider IN ('nhl', 'nhl_api', 'nhl_gamecenter')
           AND game_id = ?
         LIMIT 1`,
      )
      .get(gameId);
    if (row?.external_game_id) return String(row.external_game_id);
  } catch {
    // game_id_map may not exist — fall through
  }

  // Fall back: 10-digit NHL Gamecenter IDs start with "20" (e.g. 2024021234).
  // Reject shorter ESPN-format IDs (9 digits like 401869775).
  const raw = String(gameId || '').trim();
  if (/^20\d{8}$/.test(raw)) return raw;

  return null;
}

async function fetchMlbPitcherKs(gamePk) {
  const urls = [
    `https://statsapi.mlb.com/api/v1.1/game/${gamePk}/feed/live`,
    `https://statsapi.mlb.com/api/v1/game/${gamePk}/feed/live`,
  ];
  for (const url of urls) {
    try {
      const res = await fetch(url, { headers: { 'user-agent': 'cheddar-logic-worker' } });
      if (!res.ok) continue;
      const data = await res.json();
      const gameState = String(data?.gameData?.status?.abstractGameState || '').toUpperCase();
      if (gameState !== 'FINAL') return { available: false, reason: 'game_not_final' };
      const ksByPlayerId = {};
      for (const side of ['home', 'away']) {
        const players = data?.liveData?.boxscore?.teams?.[side]?.players ?? {};
        for (const [key, pData] of Object.entries(players)) {
          const ks = pData?.stats?.pitching?.strikeOuts;
          if (ks !== undefined && ks !== null) {
            // key is "ID8675309"
            const id = key.replace(/^ID/, '');
            ksByPlayerId[id] = Number(ks);
          }
        }
      }
      return { available: true, ksByPlayerId };
    } catch {
      // try next url
    }
  }
  return { available: false, reason: 'fetch_failed' };
}

async function settleProjections({ jobKey = null, dryRun = false, backfillMissingProxyEvals = false } = {}) {
  const jobRunId = `job-${JOB_NAME}-${new Date().toISOString().split('.')[0]}-${uuidV4().slice(0, 8)}`;

  return withDb(async () => {
    if (jobKey && !shouldRunJobKey(jobKey)) {
      return { success: true, skipped: true, jobRunId: null };
    }

    // Sequential ordering guard: projection settlement must not run before game results complete.
    // Job key format: settle|hourly|YYYY-MM-DD|HH|projections (or settle|nightly|YYYY-MM-DD|projections).
    // Replace the |projections suffix with |game-results to derive the expected game-results key.
    if (jobKey) {
      const gameResultsJobKey = jobKey.replace(/\|projections$/, '|game-results');
      if (!hasSuccessfulJobRun(gameResultsJobKey)) {
        console.log(
          `[${JOB_NAME}] SKIP: settle_game_results not yet SUCCESS for this window — skipping projection settlement (expected key: ${gameResultsJobKey})`,
        );
        return { success: true, jobRunId: null, skipped: true, guardedBy: 'game-results', jobKey };
      }
    }

    let jobInserted = false;
    try {
      if (!dryRun) {
        insertJobRun(JOB_NAME, jobRunId, jobKey);
        jobInserted = true;
      }

      const db = getDatabase();
      const unsettled = getUnsettledProjectionCards({ includeMissingProxyEvals: backfillMissingProxyEvals });

      if (unsettled.length === 0) {
        if (!dryRun) markJobRunSuccess(jobRunId, { settled: 0, skipped: 0 });
        console.log(`[${JOB_NAME}] settled=0 skipped=0`);
        return { success: true, jobRunId, settled: 0, skipped: 0 };
      }

      let settled = 0;
      let backfilled = 0;
      let skipped = 0;
      const pitcherKTelemetry = {
        captured: 0,
        no_game_pk: 0,
        no_player_match: 0,
        not_final: 0,
        fetch_failed: 0,
      };

      for (const card of unsettled) {
        try {
          const payload =
            typeof card.payload_data === 'string'
              ? JSON.parse(card.payload_data)
              : card.payload_data;
          const storedActualResult = getStoredActualResult(card);

          if (backfillMissingProxyEvals && card.actual_result) {
            const insertedRows = dryRun ? 0 : insertProjectionProxyRows(db, card, payload, storedActualResult);
            if (insertedRows > 0) {
              backfilled++;
            } else {
              skipped++;
            }
            continue;
          }

          // ── NHL nhl-pace-1p ──────────────────────────────────────────────
          if (card.card_type === 'nhl-pace-1p') {
            const nhlGameId = resolveNhlGamecenterId(db, card.game_id);
            if (!nhlGameId) {
              console.warn(
                `  [${JOB_NAME}] nhl ${card.game_id}: no NHL Gamecenter ID resolvable`,
              );
              skipped++;
              continue;
            }

            const snapshot = await fetchNhlSettlementSnapshot({ nhlGameId });

            if (!snapshot.available) {
              console.warn(
                `  [${JOB_NAME}] nhl ${card.game_id}: snapshot unavailable (${snapshot.reason || 'unknown'})`,
              );
              skipped++;
              continue;
            }

            if (!snapshot.isFirstPeriodComplete) {
              // Game not yet past 1P — skip silently, will be retried
              skipped++;
              continue;
            }

            const goals1p =
              (snapshot.homeFirstPeriodScore ?? 0) +
              (snapshot.awayFirstPeriodScore ?? 0);

            if (!dryRun) {
              setProjectionActualResult(card.card_id, { goals_1p: goals1p });
            }
            console.log(
              `  [${JOB_NAME}] nhl ${card.game_id}: goals_1p=${goals1p}`,
            );

            // Persist proxy-line grades for NHL 1P
            if (!dryRun) insertProjectionProxyRows(db, card, payload, { goals_1p: goals1p });

            settled++;
            continue;
          }

          // ── MLB mlb-f5 ───────────────────────────────────────────────────
          if (card.card_type === 'mlb-f5') {
            const gamePk = resolveMlbGamePk(db, card);

            if (!gamePk) {
              console.warn(
                `  [${JOB_NAME}] mlb ${card.game_id}: no gamePk resolved`,
              );
              skipped++;
              continue;
            }

            const actualF5 = await fetchF5Total(gamePk);

            if (actualF5 === null) {
              // Game may not yet be 5 innings complete — skip silently
              skipped++;
              continue;
            }

            if (!dryRun) {
              setProjectionActualResult(card.card_id, { runs_f5: actualF5 });
            }
            console.log(
              `  [${JOB_NAME}] mlb ${card.game_id}: runs_f5=${actualF5}`,
            );

            // Persist proxy-line grades for MLB F5
            if (!dryRun) insertProjectionProxyRows(db, card, payload, { runs_f5: actualF5 });

            settled++;
            continue;
          }

          // ── MLB mlb-f5-ml ────────────────────────────────────────────────
          if (card.card_type === 'mlb-f5-ml') {
            const gamePk = resolveMlbGamePk(db, card);

            if (!gamePk) {
              console.warn(
                `  [${JOB_NAME}] mlb ${card.game_id}: no gamePk resolved`,
              );
              skipped++;
              continue;
            }

            const gameState = await fetchF5GameState(gamePk);
            if (!gameState) {
              skipped++;
              continue;
            }

            const snapshot = resolveF5Snapshot(gameState);
            if (snapshot.status !== 'READY') {
              skipped++;
              continue;
            }

            const winner =
              snapshot.home_runs > snapshot.away_runs
                ? 'HOME'
                : snapshot.away_runs > snapshot.home_runs
                  ? 'AWAY'
                  : 'PUSH';
            const selectedSide = resolveF5MlSelectedSide(payload);
            const actualSelectedSide = resolveF5MlActualForSelectedSide(winner, selectedSide);

            if (!dryRun) {
              setProjectionActualResult(card.card_id, {
                f5_home_runs: snapshot.home_runs,
                f5_away_runs: snapshot.away_runs,
                f5_winner: winner,
                f5_ml_actual: actualSelectedSide,
                selected_side: selectedSide,
              });
            }

            console.log(
              `  [${JOB_NAME}] mlb ${card.game_id}: f5_ml home=${snapshot.home_runs} away=${snapshot.away_runs} winner=${winner}`,
            );

            if (!dryRun) {
              insertProjectionProxyRows(db, card, payload, {
                f5_ml_actual: actualSelectedSide,
                f5_winner: winner,
                selected_side: selectedSide,
              });
            }

            settled++;
            continue;
          }

          // ── NHL nhl-player-shots ─────────────────────────────────────────
          if (card.card_type === 'nhl-player-shots') {
            const nhlGameId = resolveNhlGamecenterId(db, card.game_id);
            if (!nhlGameId) {
              console.warn(
                `  [${JOB_NAME}] nhl ${card.game_id}: no NHL Gamecenter ID resolvable`,
              );
              skipped++;
              continue;
            }

            const snapshot = await fetchNhlSettlementSnapshot({ nhlGameId });

            if (!snapshot.available) {
              console.warn(
                `  [${JOB_NAME}] nhl ${card.game_id}: snapshot unavailable (${snapshot.reason || 'unknown'})`,
              );
              skipped++;
              continue;
            }

            if (!snapshot.isFinal) {
              skipped++;
              continue;
            }

            const playerId = String(payload.player_id);
            const playerName = String(payload.player_name || '');
            const resolved = resolveNhlFullGamePlayerShots(snapshot, playerId, playerName);
            if (!resolved) {
              console.warn(
                `  [${JOB_NAME}] nhl-player-shots ${card.game_id} player=${playerId}: not found in snapshot`,
              );
              skipped++;
              continue;
            }
            const shots = resolved.value;

            // Mismatch check against game_results stored metadata
            try {
              const grRow = db.prepare(
                `SELECT metadata FROM game_results WHERE game_id = ? LIMIT 1`,
              ).get(card.game_id);
              if (grRow?.metadata) {
                const grMeta = typeof grRow.metadata === 'string'
                  ? JSON.parse(grRow.metadata)
                  : grRow.metadata;
                const storedByPlayerId = grMeta?.playerShots?.fullGameByPlayerId;
                if (storedByPlayerId && typeof storedByPlayerId === 'object') {
                  const rawStored = storedByPlayerId[playerId];
                  if (rawStored !== undefined && rawStored !== null) {
                    const storedValue = Number(rawStored);
                    if (Number.isFinite(storedValue) && storedValue !== shots) {
                      console.warn(`[NHL_SHOTS_MISMATCH] game=${card.game_id} player=${playerId} apiValue=${shots} storedValue=${storedValue}`);
                    }
                  }
                }
              }
            } catch (mismatchErr) {
              // Non-fatal — mismatch check must not block settlement
              console.warn(`[NHL_SHOTS_MISMATCH_CHECK_ERROR] ${mismatchErr.message}`);
            }

            if (!dryRun) {
              setProjectionActualResult(card.card_id, { shots });
            }
            console.log(
              `  [${JOB_NAME}] nhl-player-shots ${card.game_id} player=${playerId}: shots=${shots}`,
            );
            settled++;
            continue;
          }

          // ── NHL nhl-player-shots-1p ──────────────────────────────────────
          if (card.card_type === 'nhl-player-shots-1p') {
            const nhlGameId = resolveNhlGamecenterId(db, card.game_id);
            if (!nhlGameId) {
              console.warn(
                `  [${JOB_NAME}] nhl ${card.game_id}: no NHL Gamecenter ID resolvable`,
              );
              skipped++;
              continue;
            }

            const snapshot = await fetchNhlSettlementSnapshot({ nhlGameId });

            if (!snapshot.available) {
              console.warn(
                `  [${JOB_NAME}] nhl ${card.game_id}: snapshot unavailable (${snapshot.reason || 'unknown'})`,
              );
              skipped++;
              continue;
            }

            if (!snapshot.isFirstPeriodComplete) {
              skipped++;
              continue;
            }

            const playerId = String(payload.player_id);
            const shots_1p = snapshot.playerShots.firstPeriodByPlayerId[playerId];
            if (shots_1p === undefined || shots_1p === null) {
              console.warn(
                `  [${JOB_NAME}] nhl-player-shots-1p ${card.game_id} player=${playerId}: not found in snapshot`,
              );
              skipped++;
              continue;
            }

            if (!dryRun) {
              setProjectionActualResult(card.card_id, { shots_1p });
            }
            console.log(
              `  [${JOB_NAME}] nhl-player-shots-1p ${card.game_id} player=${playerId}: shots_1p=${shots_1p}`,
            );
            settled++;
            continue;
          }

          // ── NHL nhl-player-blk ───────────────────────────────────────────
          if (card.card_type === 'nhl-player-blk') {
            const nhlGameId = resolveNhlGamecenterId(db, card.game_id);
            if (!nhlGameId) {
              console.warn(
                `  [${JOB_NAME}] nhl ${card.game_id}: no NHL Gamecenter ID resolvable`,
              );
              skipped++;
              continue;
            }

            const snapshot = await fetchNhlSettlementSnapshot({ nhlGameId });

            if (!snapshot.available) {
              console.warn(
                `  [${JOB_NAME}] nhl ${card.game_id}: snapshot unavailable (${snapshot.reason || 'unknown'})`,
              );
              skipped++;
              continue;
            }

            if (!snapshot.isFinal) {
              skipped++;
              continue;
            }

            const playerId = String(payload.player_id);
            const blocks = snapshot.playerBlocks.fullGameByPlayerId[playerId];
            if (blocks === undefined || blocks === null) {
              console.warn(
                `  [${JOB_NAME}] nhl-player-blk ${card.game_id} player=${playerId}: not found in snapshot`,
              );
              skipped++;
              continue;
            }

            if (!dryRun) {
              setProjectionActualResult(card.card_id, { blocks });
            }
            console.log(
              `  [${JOB_NAME}] nhl-player-blk ${card.game_id} player=${playerId}: blocks=${blocks}`,
            );
            settled++;
            continue;
          }

          // ── MLB mlb-pitcher-k ────────────────────────────────────────────
          if (card.card_type === 'mlb-pitcher-k') {
            const gamePk = resolveMlbGamePk(db, card);

            if (!gamePk) {
              if (!dryRun) {
                setProjectionSettlementMetadata(db, card.card_id, {
                  code: PITCHER_K_PROJECTION_SETTLEMENT_CODES.NO_GAME_PK,
                  message: 'Missing mlb_game_pk_map entry for finalized pitcher-K settlement',
                });
              }
              console.warn(
                `  [${JOB_NAME}] mlb ${card.game_id}: no gamePk resolved`,
              );
              pitcherKTelemetry.no_game_pk++;
              skipped++;
              continue;
            }

            const ksResult = await fetchMlbPitcherKs(gamePk);

            if (!ksResult.available) {
              if (ksResult.reason === 'game_not_final') {
                pitcherKTelemetry.not_final++;
              } else {
                pitcherKTelemetry.fetch_failed++;
                console.warn(
                  `  [${JOB_NAME}] mlb-pitcher-k ${card.game_id}: fetch unavailable (${ksResult.reason || 'unknown'})`,
                );
              }
              skipped++;
              continue;
            }

            const playerId = String(payload.player_id);
            const pitcher_ks = ksResult.ksByPlayerId[playerId];
            if (pitcher_ks === undefined) {
              if (!dryRun) {
                setProjectionSettlementMetadata(db, card.card_id, {
                  code: PITCHER_K_PROJECTION_SETTLEMENT_CODES.NO_PLAYER_MATCH,
                  message: `Pitcher ${playerId} missing from finalized MLB boxscore strikeout totals`,
                });
              }
              console.warn(
                `  [${JOB_NAME}] mlb-pitcher-k ${card.game_id} player=${playerId}: not found in boxscore`,
              );
              pitcherKTelemetry.no_player_match++;
              skipped++;
              continue;
            }

            if (!dryRun) {
              setProjectionActualResult(card.card_id, { pitcher_ks });
            }
            console.log(
              `  [${JOB_NAME}] mlb-pitcher-k ${card.game_id} player=${playerId}: pitcher_ks=${pitcher_ks}`,
            );
            pitcherKTelemetry.captured++;
            settled++;
            continue;
          }

          // Unknown card_type in the result set — skip
          skipped++;
        } catch (err) {
          console.warn(`  [${JOB_NAME}] ${card.game_id}: ${err.message}`);
          skipped++;
        }
      }

      if (!dryRun) {
        markJobRunSuccess(jobRunId, {
          settled,
          backfilled,
          skipped,
          pitcher_k: pitcherKTelemetry,
        });
      }
      console.log(
        `[${JOB_NAME}] pitcher_k=${JSON.stringify(pitcherKTelemetry)}`,
      );
      console.log(`[${JOB_NAME}] settled=${settled} backfilled=${backfilled} skipped=${skipped}`);
      return {
        success: true,
        jobRunId,
        settled,
        backfilled,
        skipped,
        pitcher_k: pitcherKTelemetry,
      };
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

function parseCliArgs(argv = process.argv.slice(2)) {
  const args = { dryRun: false, backfillMissingProxyEvals: false };
  for (const arg of argv) {
    if (arg === '--dry-run') args.dryRun = true;
    if (arg === '--backfill-missing-proxy-evals') args.backfillMissingProxyEvals = true;
  }
  return args;
}

if (require.main === module) {
  const args = parseCliArgs();
  settleProjections({ dryRun: args.dryRun, backfillMissingProxyEvals: args.backfillMissingProxyEvals })
    .then((r) => process.exit(r.success ? 0 : 1))
    .catch((err) => {
      console.error(err.message);
      process.exit(1);
    });
}

module.exports = {
  JOB_NAME,
  settleProjections,
  parseCliArgs,
  fetchMlbPitcherKs,
  classifyMlbF5ProxySettlementWindow,
  buildOfficialMlbF5ProxyRow,
};
