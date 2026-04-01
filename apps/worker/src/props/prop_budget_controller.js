'use strict';

const SKIP_REASONS = Object.freeze({
  NO_CANDIDATES: 'NO_CANDIDATES',
  BUDGET_EXCEEDED: 'BUDGET_EXCEEDED',
  NO_EVENT_ID: 'NO_EVENT_ID',
  STALE_EVENT_MAPPING: 'STALE_EVENT_MAPPING',
  MARKET_DISABLED: 'MARKET_DISABLED',
  OUTSIDE_TIME_WINDOW: 'OUTSIDE_TIME_WINDOW',
  RECENTLY_FETCHED: 'RECENTLY_FETCHED',
  BURN_RATE_EXCEEDED: 'BURN_RATE_EXCEEDED',
  STALE_ODDS: 'STALE_ODDS',
});

const MARKET_STATES = Object.freeze({
  OFF: 'OFF',
  SHADOW: 'SHADOW',
  LIMITED_LIVE: 'LIMITED_LIVE',
  FULL: 'FULL',
});

const MARKET_FRESHNESS_SLA_MINUTES = 75;

function readIntEnv(name, fallback) {
  const parsed = Number(process.env[name]);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function normalizeMarketState(value, fallback = MARKET_STATES.SHADOW) {
  const normalized = String(value || fallback).trim().toUpperCase();
  return MARKET_STATES[normalized] || fallback;
}

function buildWindowBucket(window, nowIso) {
  const minuteBucket = String(nowIso || new Date().toISOString()).slice(0, 16);
  return `${String(window || 'UNSPECIFIED').toUpperCase()}|${minuteBucket}`;
}

function increment(map, key) {
  if (!key) return;
  map[key] = (map[key] || 0) + 1;
}

function projectMonthlyUsage(monthlyTokenCost, now = new Date()) {
  const daysInMonth = new Date(
    now.getUTCFullYear(),
    now.getUTCMonth() + 1,
    0,
  ).getUTCDate();
  const elapsedDays = now.getUTCDate() - 1 + (now.getUTCHours() + 1) / 24;
  if (elapsedDays <= 0) return monthlyTokenCost;
  return (monthlyTokenCost / elapsedDays) * daysInMonth;
}

function applyPropBudgetController({
  candidates = [],
  window = 'T60',
  now = new Date().toISOString(),
  marketState = process.env.MLB_K_PROPS || MARKET_STATES.SHADOW,
  recentUsage = [],
  hourlySummary = null,
  dailySummary = null,
  monthlySummary = null,
  maxPerSlate = readIntEnv('MAX_PROP_EVENTS_PER_SLATE', 12),
  maxPerGame = readIntEnv('MAX_PROP_EVENTS_PER_GAME', 2),
  maxDailyCalls = readIntEnv('MAX_DAILY_PROP_CALLS', 150),
  hourlyBurnCap = readIntEnv('PROP_HOURLY_BURN_CAP', 25),
  monthlyBudget = readIntEnv('PROP_MONTHLY_BUDGET', 20000),
} = {}) {
  const normalizedState = normalizeMarketState(marketState);
  const normalizedWindow = String(window || 'T60').toUpperCase();
  const reasonCounts = {};
  const skipped = [];
  const approvedPulls = [];

  const candidateList = Array.isArray(candidates) ? [...candidates] : [];
  if (candidateList.length === 0) {
    increment(reasonCounts, SKIP_REASONS.NO_CANDIDATES);
    return {
      approvedPulls,
      skipped,
      telemetry: {
        candidates_evaluated: 0,
        approved_calls: 0,
        reason_counts: reasonCounts,
      },
      globalReason: SKIP_REASONS.NO_CANDIDATES,
    };
  }

  if (process.env.SAFE_MODE_ODDS === 'true' || normalizedState === MARKET_STATES.OFF) {
    increment(reasonCounts, SKIP_REASONS.MARKET_DISABLED);
    return {
      approvedPulls,
      skipped: candidateList.map((candidate) => ({
        candidate,
        reason: SKIP_REASONS.MARKET_DISABLED,
      })),
      telemetry: {
        candidates_evaluated: candidateList.length,
        approved_calls: 0,
        reason_counts: reasonCounts,
      },
      globalReason: SKIP_REASONS.MARKET_DISABLED,
    };
  }

  const hourlyTokenCost = Number(hourlySummary?.token_cost || 0);
  const monthlyTokenCost = Number(monthlySummary?.token_cost || 0);
  const projectedMonthlyUsage = projectMonthlyUsage(monthlyTokenCost, new Date(now));
  if (
    (hourlyBurnCap > 0 && hourlyTokenCost > hourlyBurnCap) ||
    (monthlyBudget > 0 && projectedMonthlyUsage > monthlyBudget * 1.15)
  ) {
    increment(reasonCounts, SKIP_REASONS.BURN_RATE_EXCEEDED);
    return {
      approvedPulls,
      skipped: candidateList.map((candidate) => ({
        candidate,
        reason: SKIP_REASONS.BURN_RATE_EXCEEDED,
      })),
      telemetry: {
        candidates_evaluated: candidateList.length,
        approved_calls: 0,
        reason_counts: reasonCounts,
      },
      globalReason: SKIP_REASONS.BURN_RATE_EXCEEDED,
    };
  }

  const dailyCalls = Number(dailySummary?.total_calls || 0);
  if (maxDailyCalls > 0 && dailyCalls >= maxDailyCalls) {
    increment(reasonCounts, SKIP_REASONS.BUDGET_EXCEEDED);
    return {
      approvedPulls,
      skipped: candidateList.map((candidate) => ({
        candidate,
        reason: SKIP_REASONS.BUDGET_EXCEEDED,
      })),
      telemetry: {
        candidates_evaluated: candidateList.length,
        approved_calls: 0,
        reason_counts: reasonCounts,
      },
      globalReason: SKIP_REASONS.BUDGET_EXCEEDED,
    };
  }

  const recentDedupeKeys = new Set(
    (Array.isArray(recentUsage) ? recentUsage : [])
      .map((row) => String(row?.dedupe_key || '').trim())
      .filter(Boolean),
  );
  const windowBucket = buildWindowBucket(normalizedWindow, now);
  const perGameSelections = new Map();
  const windowCap =
    normalizedWindow === 'MIDDAY'
      ? Math.min(maxPerSlate, 3)
      : maxPerSlate;

  candidateList.sort((left, right) => {
    if (right.priority_score !== left.priority_score) {
      return right.priority_score - left.priority_score;
    }
    return `${left.game_id}:${left.player_name}`.localeCompare(
      `${right.game_id}:${right.player_name}`,
    );
  });

  for (const [index, candidate] of candidateList.entries()) {
    if (
      normalizedWindow !== 'T60' &&
      String(candidate?.confidence || '').toUpperCase() !== 'HIGH'
    ) {
      increment(reasonCounts, SKIP_REASONS.OUTSIDE_TIME_WINDOW);
      skipped.push({ candidate, reason: SKIP_REASONS.OUTSIDE_TIME_WINDOW });
      continue;
    }

    const dedupeKey = `${candidate.game_id}:${candidate.market_type}:${windowBucket}`;
    if (recentDedupeKeys.has(dedupeKey)) {
      increment(reasonCounts, SKIP_REASONS.RECENTLY_FETCHED);
      skipped.push({ candidate, reason: SKIP_REASONS.RECENTLY_FETCHED });
      continue;
    }

    const selectedForGame = perGameSelections.get(candidate.game_id) || 0;
    if (selectedForGame >= maxPerGame) {
      increment(reasonCounts, SKIP_REASONS.BUDGET_EXCEEDED);
      skipped.push({ candidate, reason: SKIP_REASONS.BUDGET_EXCEEDED });
      continue;
    }

    if (approvedPulls.length >= windowCap) {
      increment(reasonCounts, SKIP_REASONS.BUDGET_EXCEEDED);
      skipped.push({ candidate, reason: SKIP_REASONS.BUDGET_EXCEEDED });
      continue;
    }

    if (approvedPulls.some((request) => request.gameId === candidate.game_id)) {
      perGameSelections.set(candidate.game_id, selectedForGame + 1);
      continue;
    }

    approvedPulls.push({
      gameId: candidate.game_id,
      marketType: candidate.market_type,
      selectionType: candidate.selection_type,
      dedupeKey,
      freshnessSlaMinutes: MARKET_FRESHNESS_SLA_MINUTES,
      candidateRank: index + 1,
      priorityScore: candidate.priority_score,
      confidence: candidate.confidence,
      playerId: candidate.player_id,
      playerName: candidate.player_name,
    });
    perGameSelections.set(candidate.game_id, selectedForGame + 1);
    recentDedupeKeys.add(dedupeKey);
  }

  if (approvedPulls.length === 0 && Object.keys(reasonCounts).length === 0) {
    increment(reasonCounts, SKIP_REASONS.BUDGET_EXCEEDED);
  }

  return {
    approvedPulls,
    skipped,
    telemetry: {
      candidates_evaluated: candidateList.length,
      approved_calls: approvedPulls.length,
      reason_counts: reasonCounts,
    },
    globalReason: approvedPulls.length === 0 ? Object.keys(reasonCounts)[0] || null : null,
  };
}

module.exports = {
  SKIP_REASONS,
  MARKET_STATES,
  MARKET_FRESHNESS_SLA_MINUTES,
  normalizeMarketState,
  buildWindowBucket,
  projectMonthlyUsage,
  applyPropBudgetController,
};
