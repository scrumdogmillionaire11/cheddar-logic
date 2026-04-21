'use strict';

require('dotenv').config();

const { v4: uuidV4 } = require('uuid');
const {
  insertJobRun,
  markJobRunSuccess,
  markJobRunFailure,
  shouldRunJobKey,
  withDb,
  getDatabase,
  normalizeMarketType,
  normalizeSelectionForMarket,
  parseLine,
} = require('@cheddar-logic/data');
const {
  __private: { gradeLockedMarket, computePnlUnits },
} = require('../settle_pending_cards');

const JOB_NAME = 'settle_potd_shadow_candidates';
const DEFAULT_VIRTUAL_STAKE_UNITS = Number(process.env.POTD_SHADOW_VIRTUAL_STAKE_UNITS || 1.0);
const DEBUG_SHADOW_SETTLEMENT = String(process.env.POTD_SHADOW_SETTLEMENT_DEBUG || '').toLowerCase() === 'true';

function toFiniteNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function toIntegerOdds(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed === 0) return null;
  return Math.trunc(parsed);
}

function isFinalResultRow(row) {
  return String(row?.game_result_status || '').toLowerCase() === 'final';
}

function upsertShadowResult(db, payload) {
  const stmt = db.prepare(`
    INSERT INTO potd_shadow_results (
      play_date,
      candidate_identity_key,
      shadow_candidate_id,
      game_id,
      sport,
      market_type,
      selection,
      selection_label,
      line,
      price,
      game_time_utc,
      status,
      result,
      virtual_stake_units,
      pnl_units,
      settled_at,
      grading_metadata,
      updated_at
    ) VALUES (
      @play_date,
      @candidate_identity_key,
      @shadow_candidate_id,
      @game_id,
      @sport,
      @market_type,
      @selection,
      @selection_label,
      @line,
      @price,
      @game_time_utc,
      @status,
      @result,
      @virtual_stake_units,
      @pnl_units,
      @settled_at,
      @grading_metadata,
      @updated_at
    )
    ON CONFLICT(play_date, candidate_identity_key) DO UPDATE SET
      shadow_candidate_id = excluded.shadow_candidate_id,
      game_id = excluded.game_id,
      sport = excluded.sport,
      market_type = excluded.market_type,
      selection = excluded.selection,
      selection_label = excluded.selection_label,
      line = excluded.line,
      price = excluded.price,
      game_time_utc = excluded.game_time_utc,
      status = excluded.status,
      result = excluded.result,
      virtual_stake_units = excluded.virtual_stake_units,
      pnl_units = excluded.pnl_units,
      settled_at = excluded.settled_at,
      grading_metadata = excluded.grading_metadata,
      updated_at = excluded.updated_at
    WHERE potd_shadow_results.status != 'settled'
  `);

  return stmt.run(payload);
}

function buildMetadata(base) {
  return JSON.stringify({
    grading_version: 'shadow-v1',
    ...base,
  });
}

function logDebug(row, reason, extra = {}) {
  if (!DEBUG_SHADOW_SETTLEMENT) return;
  console.log(JSON.stringify({
    type: 'POTD_SHADOW_SETTLEMENT_DEBUG',
    reason,
    shadow_candidate_id: row?.shadow_candidate_id ?? null,
    candidate_identity_key: row?.candidate_identity_key ?? null,
    game_id: row?.game_id ?? null,
    sport: row?.sport ?? null,
    market_type: row?.market_type ?? null,
    game_result_status: row?.game_result_status ?? null,
    ...extra,
  }));
}

async function settleShadowCandidates({ jobKey = null, dryRun = false } = {}) {
  const nowIso = new Date().toISOString();
  const jobRunId = `job-potd-shadow-settle-${uuidV4().slice(0, 8)}`;
  const virtualStakeUnits = Number.isFinite(DEFAULT_VIRTUAL_STAKE_UNITS) && DEFAULT_VIRTUAL_STAKE_UNITS > 0
    ? DEFAULT_VIRTUAL_STAKE_UNITS
    : 1.0;

  return withDb(async () => {
    if (jobKey && !shouldRunJobKey(jobKey)) {
      return { success: true, skipped: true, jobKey };
    }

    if (dryRun) {
      return { success: true, dryRun: true, jobKey };
    }

    insertJobRun(JOB_NAME, jobRunId, jobKey);

    try {
      const db = getDatabase();
      const rows = db
        .prepare(
          `SELECT
             sc.id AS shadow_candidate_id,
             sc.play_date,
             sc.candidate_identity_key,
             sc.game_id,
             sc.sport,
             sc.market_type,
             sc.selection,
             sc.selection_label,
             sc.home_team,
             sc.away_team,
             sc.line,
             sc.price,
             sc.game_time_utc,
             gr.final_score_home,
             gr.final_score_away,
             gr.status AS game_result_status,
             gr.settled_at AS game_result_settled_at,
             sr.status AS existing_status
           FROM potd_shadow_candidates sc
           LEFT JOIN game_results gr ON gr.game_id = sc.game_id
           LEFT JOIN potd_shadow_results sr
             ON sr.play_date = sc.play_date
            AND sr.candidate_identity_key = sc.candidate_identity_key
           ORDER BY sc.play_date ASC, sc.id ASC`,
        )
        .all();

      const summary = {
        settled: 0,
        pending: 0,
        non_gradeable: 0,
        win: 0,
        loss: 0,
        push: 0,
      };
      const diagnostics = {
        candidatesLoaded: rows.length,
        existingSettledSkipped: 0,
        missingGameId: 0,
        joinedGameResults: 0,
        missingGameResult: 0,
        nonFinalGameResult: 0,
        unsupportedMarketType: 0,
        gradingContractError: 0,
      };

      const tx = db.transaction(() => {
        for (const row of rows) {
          if (row.existing_status === 'settled') {
            diagnostics.existingSettledSkipped += 1;
            continue;
          }

          const resolvedCandidateIdentity = row.candidate_identity_key || `missing:${row.shadow_candidate_id}`;
          if (row.game_result_status != null) {
            diagnostics.joinedGameResults += 1;
          }

          const basePayload = {
            play_date: row.play_date,
            candidate_identity_key: resolvedCandidateIdentity,
            shadow_candidate_id: row.shadow_candidate_id,
            game_id: row.game_id,
            sport: row.sport,
            market_type: row.market_type,
            selection: row.selection,
            selection_label: row.selection_label,
            line: row.line,
            price: toIntegerOdds(row.price),
            game_time_utc: row.game_time_utc,
            virtual_stake_units: virtualStakeUnits,
            updated_at: nowIso,
          };

          if (!row.game_id) {
            diagnostics.missingGameId += 1;
            logDebug(row, 'missing_game_id');
            upsertShadowResult(db, {
              ...basePayload,
              status: 'non_gradeable',
              result: null,
              pnl_units: null,
              settled_at: null,
              grading_metadata: buildMetadata({ reason: 'missing_game_id' }),
            });
            summary.non_gradeable += 1;
            continue;
          }

          const marketType = normalizeMarketType(row.market_type);
          if (!marketType || !['MONEYLINE', 'SPREAD', 'TOTAL'].includes(marketType)) {
            diagnostics.unsupportedMarketType += 1;
            logDebug(row, 'unsupported_market_type', { normalized_market_type: marketType });
            upsertShadowResult(db, {
              ...basePayload,
              status: 'non_gradeable',
              result: null,
              pnl_units: null,
              settled_at: null,
              grading_metadata: buildMetadata({ reason: 'unsupported_market_type', marketType: row.market_type }),
            });
            summary.non_gradeable += 1;
            continue;
          }

          if (!isFinalResultRow(row)) {
            const reason = row.game_result_status == null
              ? 'missing_game_result'
              : 'non_final_game_result';
            if (reason === 'missing_game_result') {
              diagnostics.missingGameResult += 1;
            } else {
              diagnostics.nonFinalGameResult += 1;
            }
            logDebug(row, reason);
            upsertShadowResult(db, {
              ...basePayload,
              status: 'pending',
              result: null,
              pnl_units: null,
              settled_at: null,
              grading_metadata: buildMetadata({
                reason,
                game_result_status: row.game_result_status ?? null,
              }),
            });
            summary.pending += 1;
            continue;
          }

          try {
            const selection = normalizeSelectionForMarket({
              marketType,
              selection: row.selection,
              homeTeam: row.home_team,
              awayTeam: row.away_team,
            });
            const line = parseLine(row.line);
            const result = gradeLockedMarket({
              marketType,
              selection,
              line,
              homeScore: row.final_score_home,
              awayScore: row.final_score_away,
              period: 'FULL_GAME',
            });
            const odds = toIntegerOdds(row.price);
            const basePnlUnits = computePnlUnits(result, odds);
            const pnlUnits = basePnlUnits == null
              ? null
              : Number((basePnlUnits * virtualStakeUnits).toFixed(6));

            upsertShadowResult(db, {
              ...basePayload,
              status: 'settled',
              result,
              pnl_units: pnlUnits,
              settled_at: row.game_result_settled_at || nowIso,
              grading_metadata: buildMetadata({
                home_score: toFiniteNumber(row.final_score_home),
                away_score: toFiniteNumber(row.final_score_away),
                base_pnl_units: basePnlUnits,
              }),
            });

            summary.settled += 1;
            if (result === 'win') summary.win += 1;
            if (result === 'loss') summary.loss += 1;
            if (result === 'push') summary.push += 1;
          } catch (error) {
            diagnostics.gradingContractError += 1;
            logDebug(row, 'grading_contract_error', { message: error.message });
            upsertShadowResult(db, {
              ...basePayload,
              status: 'non_gradeable',
              result: null,
              pnl_units: null,
              settled_at: null,
              grading_metadata: buildMetadata({
                reason: 'grading_contract_error',
                message: error.message,
              }),
            });
            summary.non_gradeable += 1;
          }
        }
      });

      tx();
      const result = {
        success: true,
        jobRunId,
        ...summary,
        diagnostics,
      };
      console.log(
        `[POTD Shadow Settlement] candidates=${diagnostics.candidatesLoaded} ` +
        `joined_results=${diagnostics.joinedGameResults} ` +
        `missing_results=${diagnostics.missingGameResult} ` +
        `non_final=${diagnostics.nonFinalGameResult} ` +
        `unsupported=${diagnostics.unsupportedMarketType} ` +
        `settled=${summary.settled} pending=${summary.pending} ` +
        `non_gradeable=${summary.non_gradeable} skipped_settled=${diagnostics.existingSettledSkipped}`,
      );
      markJobRunSuccess(jobRunId, result);
      return {
        ...result,
      };
    } catch (error) {
      markJobRunFailure(jobRunId, error.message);
      throw error;
    }
  });
}

if (require.main === module) {
  settleShadowCandidates().then(console.log).catch(console.error);
}

module.exports = {
  settleShadowCandidates,
};
