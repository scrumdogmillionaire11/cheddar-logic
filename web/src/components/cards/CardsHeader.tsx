'use client';

import { formatSportCounts } from './CardsPageContext';
import { useCardsPageState } from './CardsPageContext';
import { formatDate } from './game-card-helpers';

export default function CardsHeader() {
  const {
    diagnosticsEnabled,
    displayedCardsInView,
    dropTraceStats,
    error,
    guardrailStats,
    hiddenDataErrorCards,
    hiddenDataErrors,
    loading,
    todayEtKey,
    totalCardsInView,
    viewMode,
    traceStats,
  } = useCardsPageState();

  return (
    <div className="mb-8 space-y-2">
      <h1 className="text-4xl font-bold">🧀 The Cheddar Board 🧀</h1>
      <p className="text-cloud/70">
        {totalCardsInView} game{totalCardsInView !== 1 ? 's' : ''} total,
        showing {displayedCardsInView} (updates in background every 60s)
      </p>
      {!loading && !error && diagnosticsEnabled && viewMode === 'game' && (
        <p className="text-xs text-cloud/60">
          Guardrails: edge verification {guardrailStats.triggered.edge_sanity_triggered}{' '}
          • proxy capped {guardrailStats.triggered.proxy_cap_triggered} • proxy
          blocked {guardrailStats.triggered.proxy_blocked} • exact wager mismatch{' '}
          {guardrailStats.triggered.exact_wager_mismatch} • market price missing{' '}
          {guardrailStats.triggered.market_price_missing}
        </p>
      )}
      {!loading && !error && diagnosticsEnabled && (
        <div className="rounded-lg border border-white/10 bg-surface/30 px-3 py-2 text-xs text-cloud/70 space-y-1">
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
