'use client';

import { useMemo } from 'react';
import { formatSportCounts } from './CardsPageContext';
import { useCardsPageState, useCardsPageActions } from './CardsPageContext';
import { formatDate } from './game-card-helpers';
import { classifyPassReasonBucket } from './shared';
import { getPlayDisplayAction } from '@/lib/game-card/decision';

export default function CardsHeader() {
  const {
    diagnosticsEnabled,
    displayedCardsInView,
    dropTraceStats,
    error,
    filteredCards,
    filters,
    guardrailStats,
    hiddenDataErrorCards,
    hiddenDataErrors,
    loading,
    todayEtKey,
    totalCardsInView,
    traceStats,
    viewMode,
  } = useCardsPageState();
  const { onFiltersChange } = useCardsPageActions();

  const isPassActive = viewMode === 'game' && filters.statuses.includes('PASS');

  const handlePassToggle = () => {
    const newStatuses = isPassActive
      ? filters.statuses.filter((s) => s !== 'PASS')
      : ([...filters.statuses, 'PASS'] as typeof filters.statuses);
    onFiltersChange({ ...filters, statuses: newStatuses });
  };

  const passBucketCounts = useMemo(() => {
    if (!isPassActive) return null;
    const counts = { 'odds-blocked': 0, 'data-error': 0, 'projection-only': 0 };
    for (const card of filteredCards) {
      if (getPlayDisplayAction(card.play) !== 'PASS') continue;
      const bucket = classifyPassReasonBucket(card);
      if (bucket) counts[bucket] += 1;
    }
    return counts;
  }, [isPassActive, filteredCards]);

  return (
    <div className="mb-8 space-y-2">
      <h1 className="text-4xl font-bold">🧀 The Wedge 🧀</h1>
      <p className="text-cloud/70">
        {totalCardsInView} game{totalCardsInView !== 1 ? 's' : ''} total,
        showing {displayedCardsInView} (updates in background every 60s)
      </p>
      {viewMode === 'game' && !loading && !error && (
        <div className="flex items-center gap-3 flex-wrap">
          <button
            onClick={handlePassToggle}
            className={`px-3 py-1 text-xs font-semibold rounded border transition-colors ${
              isPassActive
                ? 'bg-slate-600/60 text-slate-200 border-slate-500/60'
                : 'bg-white/5 text-cloud/50 border-white/10 hover:bg-white/10 hover:text-cloud/70'
            }`}
          >
            {isPassActive ? 'Hide PASS' : 'Show PASS'}
          </button>
          {isPassActive && passBucketCounts && (
            <span className="text-xs text-cloud/50 font-mono">
              Odds-blocked: {passBucketCounts['odds-blocked']} | Data error:{' '}
              {passBucketCounts['data-error']} | Projection-only:{' '}
              {passBucketCounts['projection-only']}
            </span>
          )}
        </div>
      )}
      {!loading && !error && diagnosticsEnabled && (
        <details className="rounded-lg border border-white/10 bg-surface/30 px-3 py-2 text-xs text-cloud/70">
          <summary className="cursor-pointer select-none text-cloud/60 hover:text-cloud/80">
            Debug diagnostics workflow — guardrails{' '}
            {guardrailStats.triggered.edge_sanity_triggered +
              guardrailStats.triggered.proxy_cap_triggered +
              guardrailStats.triggered.proxy_blocked +
              guardrailStats.triggered.exact_wager_mismatch +
              guardrailStats.triggered.market_price_missing}{' '}
            triggered, {hiddenDataErrors} data error
            {hiddenDataErrors !== 1 ? 's' : ''}
          </summary>
          <div className="mt-2 space-y-1">
            <p>
              Trace (all): fetched {traceStats.fetchedTotal} (
              {formatSportCounts(traceStats.fetchedBySport)}) → transformed{' '}
              {traceStats.transformedTotal} (
              {formatSportCounts(traceStats.transformedBySport)}) → displayed{' '}
              {traceStats.displayedTotal} ({formatSportCounts(traceStats.displayedBySport)})
            </p>
            <p>
              Trace (today ET {todayEtKey}): fetched (
              {formatSportCounts(traceStats.fetchedTodayBySport)}) → transformed (
              {formatSportCounts(traceStats.transformedTodayBySport)}) → displayed (
              {formatSportCounts(traceStats.displayedTodayBySport)})
            </p>
            <p>
              Filter drops: status {dropTraceStats.droppedByReason.DROP_NO_BETTABLE_STATUS}{' '}
              • market {dropTraceStats.droppedByReason.DROP_MARKET_NOT_ALLOWED} •
              time {dropTraceStats.droppedByReason.DROP_TIME_WINDOW} • data errors{' '}
              {hiddenDataErrors}
            </p>
            <p>
              Guardrails (triggered): edge {guardrailStats.triggered.edge_sanity_triggered}{' '}
              • proxy {guardrailStats.triggered.proxy_cap_triggered} • proxy blocked{' '}
              {guardrailStats.triggered.proxy_blocked} • high-edge blocked{' '}
              {guardrailStats.triggered.high_edge_non_total_blocked} • driver load fail{' '}
              {guardrailStats.triggered.driver_load_failures} • exact wager mismatch{' '}
              {guardrailStats.triggered.exact_wager_mismatch} • market price missing{' '}
              {guardrailStats.triggered.market_price_missing}
            </p>
            <p>
              Guardrails (outcome): PLAY→LEAN {guardrailStats.outcome.fire_to_watch}{' '}
              • LEAN→PASS {guardrailStats.outcome.watch_to_pass} • PLAY→PASS{' '}
              {guardrailStats.outcome.fire_to_pass} • bet removed{' '}
              {guardrailStats.outcome.bet_removed}
            </p>
          </div>
        </details>
      )}
      {!loading && !error && hiddenDataErrors > 0 && (
        <details className="rounded-md border border-amber-600/50 bg-amber-700/20 px-3 py-2 text-xs text-amber-100">
          <summary className="cursor-pointer font-semibold">
            {hiddenDataErrors} game{hiddenDataErrors !== 1 ? 's' : ''} excluded due
            to incomplete data
          </summary>
          {hiddenDataErrorCards.length > 0 && (
            <div className="mt-2 space-y-1">
              {hiddenDataErrorCards.map((card) => (
                <div
                  key={`hidden-error-${card.id}`}
                  className="rounded bg-amber-900/20 px-2 py-1"
                >
                  <span className="font-semibold">
                    {card.awayTeam} @ {card.homeTeam}
                  </span>
                  <span className="text-amber-200/90"> · {formatDate(card.startTime)}</span>
                  {card.play?.transform_meta?.missing_inputs?.length ? (
                    <span className="text-amber-200/90">
                      {' '}
                      · missing: {card.play.transform_meta.missing_inputs.join(', ')}
                    </span>
                  ) : null}
                </div>
              ))}
            </div>
          )}
        </details>
      )}
    </div>
  );
}
