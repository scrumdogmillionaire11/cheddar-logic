'use strict';

require('dotenv').config();

const { v4: uuidV4 } = require('uuid');
const {
  withDb,
  getDatabase,
  getUpcomingGames,
  shouldRunJobKey,
  insertJobRun,
  markJobRunSuccess,
  markJobRunFailure,
  upsertPropEventMapping,
  getPropEventMapping,
  recordPropOddsUsage,
  updatePropOddsUsage,
  listPropOddsUsage,
  getPropOddsUsageSummary,
} = require('@cheddar-logic/data');

const {
  buildMlbPitcherKCandidateSet,
  MARKET_FAMILY,
} = require('../props/mlb_pitcher_k_candidate_engine');
const {
  SKIP_REASONS,
  MARKET_STATES,
  MARKET_FRESHNESS_SLA_MINUTES,
  normalizeMarketState,
  applyPropBudgetController,
} = require('../props/prop_budget_controller');
const {
  pullMlbPitcherStrikeoutProps,
  fetchUpcomingMlbEvents,
  resolveGameId,
} = require('./pull_mlb_pitcher_strikeout_props');
const { runMLBModel } = require('./run_mlb_model');

const JOB_NAME = 'run_mlb_prop_pipeline';

function nowIso() {
  return new Date().toISOString();
}

function minusHours(hours, fromIso = nowIso()) {
  return new Date(new Date(fromIso).getTime() - hours * 60 * 60 * 1000).toISOString();
}

function startOfUtcDay(fromIso = nowIso()) {
  return `${String(fromIso).slice(0, 10)}T00:00:00.000Z`;
}

function startOfUtcMonth(fromIso = nowIso()) {
  const date = new Date(fromIso);
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  return `${date.getUTCFullYear()}-${month}-01T00:00:00.000Z`;
}

function normalizeWindow(window) {
  const normalized = String(window || 'T60').trim().toUpperCase();
  if (normalized === '09:00') return 'MORNING';
  if (normalized === '15:00') return 'MIDDAY';
  return normalized;
}

function isMappingStale(mapping, now = nowIso()) {
  if (!mapping) return false;
  if (String(mapping.status || '').toUpperCase() === 'EXPIRED') return true;
  if (!mapping.expires_at) return false;
  return new Date(mapping.expires_at).getTime() <= new Date(now).getTime();
}

async function syncMlbPropEventMappings({
  db,
  games = [],
  dryRun = false,
  apiKey = process.env.ODDS_API_KEY,
} = {}) {
  const gameIds = new Set(
    (Array.isArray(games) ? games : []).map((game) => String(game.game_id || '')).filter(Boolean),
  );
  if (gameIds.size === 0 || dryRun || !apiKey || process.env.APP_ENV === 'local') {
    return { mapped: 0, eventsFetched: 0 };
  }

  const { events } = await fetchUpcomingMlbEvents(apiKey);
  let mapped = 0;
  for (const event of events) {
    const gameId = resolveGameId(db, event);
    if (!gameId || !gameIds.has(String(gameId))) continue;
    upsertPropEventMapping({
      sport: 'MLB',
      marketFamily: MARKET_FAMILY,
      gameId,
      oddsEventId: event.id,
      mappedAt: nowIso(),
      expiresAt: event.commence_time || null,
      status: 'ACTIVE',
    });
    mapped += 1;
  }

  return { mapped, eventsFetched: events.length };
}

async function runMlbPropPipeline({
  jobKey = null,
  dryRun = false,
  window = 'T60',
  windowType = null,
  gameIds = null,
  games: injectedGames = null,
} = {}) {
  const jobRunId = `job-${JOB_NAME}-${new Date().toISOString().split('.')[0]}-${uuidV4().slice(0, 8)}`;
  const now = nowIso();
  const normalizedWindow = normalizeWindow(windowType || window);
  const marketState = normalizeMarketState(process.env.MLB_K_PROPS || MARKET_STATES.SHADOW);

  return withDb(async () => {
    if (jobKey && !shouldRunJobKey(jobKey)) {
      return { success: true, skipped: true, jobKey };
    }

    if (dryRun) {
      return { success: true, dryRun: true, jobKey, window: normalizedWindow };
    }

    insertJobRun(JOB_NAME, jobRunId, jobKey);

    try {
      const db = getDatabase();
      const startUtcIso = minusHours(1, now);
      const endUtcIso = new Date(new Date(now).getTime() + 36 * 60 * 60 * 1000).toISOString();
      const games =
        injectedGames ||
        getUpcomingGames({
          startUtcIso,
          endUtcIso,
          sports: ['mlb'],
        });
      const filteredGames = Array.isArray(gameIds) && gameIds.length > 0
        ? games.filter((game) => gameIds.includes(game.game_id))
        : games.filter((game) => String(game.sport || '').toLowerCase() === 'mlb');
      const candidateSet = buildMlbPitcherKCandidateSet({
        games: filteredGames,
        gameIds,
        now,
        db,
      });
      const hasCandidates = candidateSet.candidates.length > 0;
      const mappingSync = hasCandidates
        ? await syncMlbPropEventMappings({
            db,
            games: filteredGames,
            dryRun,
          })
        : { mapped: 0, eventsFetched: 0 };

      const recentUsage = listPropOddsUsage({
        sport: 'MLB',
        marketFamily: MARKET_FAMILY,
        since: minusHours(6, now),
      });
      const hourlySummary = getPropOddsUsageSummary({
        sport: 'MLB',
        marketFamily: MARKET_FAMILY,
        since: minusHours(1, now),
      });
      const dailySummary = getPropOddsUsageSummary({
        sport: 'MLB',
        marketFamily: MARKET_FAMILY,
        since: startOfUtcDay(now),
      });
      const monthlySummary = getPropOddsUsageSummary({
        sport: 'MLB',
        marketFamily: MARKET_FAMILY,
        since: startOfUtcMonth(now),
      });

      const budgetDecision = applyPropBudgetController({
        candidates: candidateSet.candidates,
        window: normalizedWindow,
        now,
        marketState,
        recentUsage,
        hourlySummary,
        dailySummary,
        monthlySummary,
      });

      const telemetry = {
        token_cost: 0,
        scoped_calls: 0,
        candidates_evaluated: candidateSet.meta.total_candidates,
        executable_props_published: 0,
        leans_only_count: 0,
        pass_count: 0,
        reason_counts: {
          ...(candidateSet.meta.reason_counts || {}),
          ...(budgetDecision.telemetry.reason_counts || {}),
        },
      };

      if (!hasCandidates) {
        markJobRunSuccess(jobRunId);
        return {
          success: true,
          jobRunId,
          window: normalizedWindow,
          market_state: marketState,
          candidates: candidateSet,
          mapping_sync: mappingSync,
          telemetry: {
            ...telemetry,
            tokens_per_executable_prop: 0,
            tokens_per_slate: 0,
            wasted_calls: 0,
          },
          skipped_reason: SKIP_REASONS.NO_CANDIDATES,
        };
      }

      if (normalizedWindow === 'MORNING') {
        markJobRunSuccess(jobRunId);
        return {
          success: true,
          jobRunId,
          window: normalizedWindow,
          market_state: marketState,
          candidates: candidateSet,
          mapping_sync: mappingSync,
          telemetry: {
            ...telemetry,
            tokens_per_executable_prop: 0,
            tokens_per_slate: 0,
            wasted_calls: 0,
          },
          skipped_reason: SKIP_REASONS.OUTSIDE_TIME_WINDOW,
        };
      }

      if (budgetDecision.approvedPulls.length === 0) {
        markJobRunSuccess(jobRunId);
        return {
          success: true,
          jobRunId,
          window: normalizedWindow,
          market_state: marketState,
          candidates: candidateSet,
          mapping_sync: mappingSync,
          telemetry: {
            ...telemetry,
            tokens_per_executable_prop: 0,
            tokens_per_slate: 0,
            wasted_calls: 0,
          },
          skipped_reason: budgetDecision.globalReason,
        };
      }

      const rerunGameIds = new Set();
      const usageDedupeKeys = [];

      for (const pullRequest of budgetDecision.approvedPulls) {
        const mapping = getPropEventMapping({
          sport: 'MLB',
          marketFamily: MARKET_FAMILY,
          gameId: pullRequest.gameId,
        });
        const mappingReason = !mapping
          ? SKIP_REASONS.NO_EVENT_ID
          : isMappingStale(mapping, now)
            ? SKIP_REASONS.STALE_EVENT_MAPPING
            : null;

        const recorded = recordPropOddsUsage({
          id: uuidV4(),
          sport: 'MLB',
          marketFamily: MARKET_FAMILY,
          gameId: pullRequest.gameId,
          oddsEventId: mapping?.odds_event_id || null,
          dedupeKey: pullRequest.dedupeKey,
          windowBucket: pullRequest.dedupeKey.split(':').slice(2).join(':'),
          jobName: JOB_NAME,
          status: mappingReason ? 'SKIPPED' : 'PENDING',
          skipReason: mappingReason,
          candidateRank: pullRequest.candidateRank,
          candidatesEvaluated: telemetry.candidates_evaluated,
          metadata: {
            window: normalizedWindow,
            confidence: pullRequest.confidence,
            priority_score: pullRequest.priorityScore,
          },
        });

        if (!recorded) {
          telemetry.reason_counts[SKIP_REASONS.RECENTLY_FETCHED] =
            (telemetry.reason_counts[SKIP_REASONS.RECENTLY_FETCHED] || 0) + 1;
          continue;
        }

        usageDedupeKeys.push(pullRequest.dedupeKey);
        if (mappingReason) {
          telemetry.reason_counts[mappingReason] =
            (telemetry.reason_counts[mappingReason] || 0) + 1;
          continue;
        }

        const pullResult = await pullMlbPitcherStrikeoutProps({
          jobKey: `${jobKey || JOB_NAME}|${pullRequest.dedupeKey}`,
          dryRun,
          gameId: pullRequest.gameId,
          oddsEventId: mapping.odds_event_id,
          pipelineMode: true,
          requireScoped: true,
        });

        updatePropOddsUsage({
          dedupeKey: pullRequest.dedupeKey,
          status: pullResult.skipped ? 'SKIPPED' : pullResult.success ? 'SUCCESS' : 'FAILED',
          skipReason: pullResult.reason || null,
          tokenCost: Number(pullResult.tokenCost || 0),
          remainingQuota:
            Number.isFinite(Number(pullResult.remainingQuota)) ? Number(pullResult.remainingQuota) : null,
          metadata: {
            window: normalizedWindow,
            result: pullResult,
          },
        });

        telemetry.token_cost += Number(pullResult.tokenCost || 0);
        if (pullResult.success && !pullResult.skipped) {
          telemetry.scoped_calls += 1;
          rerunGameIds.add(pullRequest.gameId);
        } else if (pullResult.reason) {
          telemetry.reason_counts[pullResult.reason] =
            (telemetry.reason_counts[pullResult.reason] || 0) + 1;
        }
      }

      let modelResult = null;
      if (rerunGameIds.size > 0) {
        modelResult = await runMLBModel({
          jobKey: `${jobKey || JOB_NAME}|mlb_model`,
          dryRun,
          gameIds: Array.from(rerunGameIds),
        });
        const pitcherSummary = modelResult?.pitcher_prop_summary || {};
        for (const gameId of rerunGameIds) {
          const summary = pitcherSummary[gameId] || {};
          telemetry.executable_props_published += Number(summary.executable_props_published || 0);
          telemetry.leans_only_count += Number(summary.leans_only_count || 0);
          telemetry.pass_count += Number(summary.pass_count || 0);
        }
      }

      for (const dedupeKey of usageDedupeKeys) {
        updatePropOddsUsage({
          dedupeKey,
          executablePropsPublished: telemetry.executable_props_published,
          leansOnlyCount: telemetry.leans_only_count,
          passCount: telemetry.pass_count,
        });
      }

      const tokensPerExecutableProp =
        telemetry.executable_props_published > 0
          ? telemetry.token_cost / telemetry.executable_props_published
          : 0;
      const tokensPerSlate =
        filteredGames.length > 0 ? telemetry.token_cost / filteredGames.length : telemetry.token_cost;
      const wastedCalls = Math.max(
        telemetry.scoped_calls - telemetry.executable_props_published,
        0,
      );

      markJobRunSuccess(jobRunId);
      return {
        success: true,
        jobRunId,
        window: normalizedWindow,
        market_state: marketState,
        candidates: candidateSet,
        mapping_sync: mappingSync,
        approved_pull_requests: budgetDecision.approvedPulls,
        telemetry: {
          ...telemetry,
          tokens_per_executable_prop: tokensPerExecutableProp,
          tokens_per_slate: tokensPerSlate,
          wasted_calls: wastedCalls,
        },
        model_result: modelResult,
      };
    } catch (error) {
      markJobRunFailure(jobRunId, error.message);
      return {
        success: false,
        jobRunId,
        error: error.message,
      };
    }
  });
}

if (require.main === module) {
  runMlbPropPipeline()
    .then((result) => {
      process.exit(result.success ? 0 : 1);
    })
    .catch((error) => {
      console.error(error);
      process.exit(1);
    });
}

module.exports = {
  JOB_NAME,
  MARKET_FAMILY,
  normalizeWindow,
  isMappingStale,
  syncMlbPropEventMappings,
  runMlbPropPipeline,
};
