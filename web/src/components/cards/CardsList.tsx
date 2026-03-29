'use client';

import ProjectionCard from '@/components/projection-card';
import PropGameCard from '@/components/prop-game-card';
import { useCardsPageActions, useCardsPageState, BUCKET_LABELS } from './CardsPageContext';
import GameCardItem from './GameCardItem';
import SportDiagnosticsPanel from './SportDiagnosticsPanel';

export default function CardsList() {
  const {
    activeFilterCount,
    diagnosticCards,
    diagnosticFilter,
    diagnosticsEnabled,
    enrichedCards,
    error,
    filteredCards,
    gameMap,
    groupedByDate,
    loading,
    projectionItems,
    propCards,
    propGroupedByDate,
    sportDiagnostics,
    viewMode,
  } = useCardsPageState();
  const { onDiagnosticFilterChange, onResetFilters } = useCardsPageActions();

  if (loading) {
    return <div className="text-center py-8 text-cloud/60">Loading games...</div>;
  }

  if (error) {
    return (
      <div className="mb-6 p-4 bg-red-900/20 border border-red-700 rounded-lg text-red-200">
        Error: {error}
      </div>
    );
  }

  return (
    <>
      {diagnosticsEnabled &&
        viewMode === 'game' &&
        enrichedCards.length > 0 && (
          <SportDiagnosticsPanel
            diagnostics={sportDiagnostics}
            onBucketClick={(sport, bucket) =>
              onDiagnosticFilterChange((prev) =>
                prev?.sport === sport && prev?.bucket === bucket
                  ? null
                  : { sport, bucket },
              )
            }
          />
        )}

      {diagnosticsEnabled && viewMode === 'game' && diagnosticFilter && (
        <div className="mb-3 flex items-center gap-2 rounded-md border border-white/10 bg-surface/40 px-3 py-1.5 text-xs text-cloud/70">
          <span>
            Showing {diagnosticCards.length} blocked {diagnosticFilter.sport} games
            {' — '}
            {BUCKET_LABELS[diagnosticFilter.bucket]}
          </span>
          <button
            onClick={() => onDiagnosticFilterChange(null)}
            className="ml-auto text-cloud/40 hover:text-cloud/70"
            aria-label="Dismiss diagnostic filter"
          >
            ✕
          </button>
        </div>
      )}

      {((viewMode === 'props' && propCards.length === 0) ||
        (viewMode === 'projections' && projectionItems.length === 0) ||
        (viewMode === 'game' && filteredCards.length === 0)) && (
        <div className="text-center py-8 space-y-4">
          <div className="text-cloud/60">
            {viewMode === 'props'
              ? 'No qualified props match your filters'
              : viewMode === 'projections'
                ? 'No game props match your filters'
                : 'No games match your filters'}
          </div>
          {diagnosticsEnabled && viewMode === 'game' && enrichedCards.length > 0 && (
            <div className="mt-2 text-left mx-auto max-w-sm text-xs text-cloud/40 space-y-1">
              <div className="font-semibold text-cloud/50 mb-1">
                {enrichedCards.length} game{enrichedCards.length !== 1 ? 's' : ''}{' '}
                excluded — breakdown by sport:
              </div>
              {Object.entries(sportDiagnostics)
                .filter(
                  ([, b]) =>
                    b.missingMapping +
                      b.driverLoadFailed +
                      b.noOdds +
                      b.noProjection >
                    0,
                )
                .map(([sport, b]) => (
                  <div key={sport} className="flex gap-2 font-mono">
                    <span className="w-16">{sport}</span>
                    {b.noOdds > 0 && <span>no-odds:{b.noOdds}</span>}
                    {b.missingMapping > 0 && <span>no-map:{b.missingMapping}</span>}
                    {b.driverLoadFailed > 0 && (
                      <span>driver-fail:{b.driverLoadFailed}</span>
                    )}
                    {b.noProjection > 0 && <span>no-proj:{b.noProjection}</span>}
                  </div>
                ))}
            </div>
          )}
          {activeFilterCount > 0 && (
            <button
              onClick={onResetFilters}
              className="px-4 py-2 rounded-lg border border-white/20 hover:border-white/40 hover:bg-surface/50 transition"
            >
              Clear All Filters
            </button>
          )}
        </div>
      )}

      {viewMode === 'props' && propGroupedByDate.length > 0 && (
        <div className="space-y-4">
          {propGroupedByDate.map(({ dateKey, label, cards: groupCards }) => (
            <div key={dateKey}>
              <div className="text-xs font-semibold text-cloud/50 uppercase tracking-wider px-1 pb-2 pt-1 border-b border-white/10 mb-3">
                {label}
              </div>
              <div className="space-y-4">
                {groupCards.map((card) => (
                  <PropGameCard key={card.gameId} card={card} />
                ))}
              </div>
            </div>
          ))}
        </div>
      )}

      {viewMode === 'projections' && projectionItems.length > 0 && (
        <div className="space-y-4">
          {projectionItems.map(({ game, play }) => (
            <ProjectionCard
              key={`${game.gameId}-gameprops`}
              homeTeam={game.homeTeam}
              awayTeam={game.awayTeam}
              startTime={game.gameTimeUtc}
              sport={game.sport?.toUpperCase() ?? 'NHL'}
              play={play}
            />
          ))}
        </div>
      )}

      {viewMode === 'game' && groupedByDate.length > 0 && (
        <div className="space-y-4">
          {groupedByDate.map(({ dateKey, label, cards: groupCards }) => (
            <div key={dateKey}>
              <div className="text-xs font-semibold text-cloud/50 uppercase tracking-wider px-1 pb-2 pt-1 border-b border-white/10 mb-3">
                {label}
              </div>
              <div className="space-y-4">
                {groupCards.map((card) => {
                  const originalGame = gameMap.get(card.gameId);
                  if (!originalGame) return null;
                  return (
                    <GameCardItem
                      key={card.id}
                      card={card}
                      originalGame={originalGame}
                    />
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      )}

      {diagnosticsEnabled &&
        viewMode === 'game' &&
        diagnosticFilter &&
        diagnosticCards.length > 0 && (
          <div className="mt-6 space-y-2">
            <div className="text-xs text-cloud/40 border-t border-white/10 pt-3 mb-2">
              Blocked games — {BUCKET_LABELS[diagnosticFilter.bucket]}
            </div>
            {diagnosticCards.map((card) => {
              const codes = card.play?.reason_codes ?? [];
              const badge = codes
                .filter(
                  (c) =>
                    c.startsWith('MISSING_DATA') ||
                    c.startsWith('PASS_DATA') ||
                    c.startsWith('PASS_DRIVER') ||
                    c.startsWith('PASS_MISSING_DRIVER') ||
                    c.startsWith('PASS_NO_PRIMARY') ||
                    c.startsWith('PASS_MARKET_PRICE') ||
                    c.startsWith('PASS_MISSING') ||
                    c === 'PASS_NO_QUALIFIED_PLAYS',
                )
                .join(', ');
              return (
                <div
                  key={`diag-${card.id}`}
                  className="flex items-center gap-3 rounded-md border border-white/5 bg-surface/20 px-3 py-2 opacity-60 text-xs"
                >
                  <span className="text-cloud/50 font-medium">
                    {card.awayTeam} @ {card.homeTeam}
                  </span>
                  {badge && (
                    <span className="ml-auto font-mono text-amber-400/70 text-[10px]">
                      {badge}
                    </span>
                  )}
                </div>
              );
            })}
          </div>
        )}
    </>
  );
}
