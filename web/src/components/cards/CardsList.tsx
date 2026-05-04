'use client';

import { useMemo, useState } from 'react';
import ProjectionCard from '@/components/projection-card';
import PropGameCard from '@/components/prop-game-card';
import {
  countBlockedDiagnostics,
  DIAGNOSTIC_BUCKET_LABELS,
} from '@/lib/game-card/pass-classification';
import { evaluateCardFilter } from '@/lib/game-card/filters';
import { getGameExclusionReason } from '@/lib/game-card/transform';
import { useCardsPageActions, useCardsPageState } from './CardsPageContext';
import GameCardItem from './GameCardItem';
import SportDiagnosticsPanel from './SportDiagnosticsPanel';

const FILTER_FLAG_LABELS: Record<string, string> = {
  sport: 'sport',
  timeWindow: 'time window',
  oddsFreshness: 'odds freshness',
  market: 'market',
  cardType: 'card type',
  actionability: 'actionability',
  driverStrength: 'driver strength',
  riskFlags: 'risk flags',
  search: 'search',
  welcomeHome: 'welcome-home gate',
  hasPicks: 'has picks',
  clearPlay: 'clear play',
  totalProjection: 'total projection',
  minEdge: 'min edge',
};

export default function CardsList() {
  const {
    activeFilterCount,
    diagnosticCards,
    diagnosticFilter,
    diagnosticsEnabled,
    effectiveFilters,
    enrichedCards,
    error,
    filteredCards,
    gameMap,
    games,
    groupedByDate,
    loading,
    projectionItems,
    propCards,
    propGroupedByDate,
    sportDiagnostics,
    viewMode,
  } = useCardsPageState();
  const { onDiagnosticFilterChange, onResetFilters } = useCardsPageActions();
  const [showLoadedDebugView, setShowLoadedDebugView] = useState(false);

  const displayedCardIds = useMemo(
    () => new Set(filteredCards.map((card) => card.id)),
    [filteredCards],
  );

  const transformedGameIds = useMemo(
    () => new Set(enrichedCards.map((card) => card.gameId)),
    [enrichedCards],
  );

  const filterDebugRows = useMemo(() => {
    if (viewMode !== 'game') return [];

    return enrichedCards.map((card) => {
      const result = evaluateCardFilter(card, effectiveFilters, 'game');
      const failedFlags = Object.entries(result.flags)
        .filter(([, pass]) => !pass)
        .map(([key]) => FILTER_FLAG_LABELS[key] ?? key);

      const play = card.play;
      const diagnostics = failedFlags.length > 0 ? [
        `market_type=${play?.market_type ?? 'null'}`,
        `decision_v2.official_status=${(play?.decision_v2 as Record<string, unknown> | null | undefined)?.official_status ?? 'null'}`,
        `execution_status=${play?.execution_status ?? 'null'}`,
      ] : [];

      return {
        id: card.id,
        gameId: card.gameId,
        sport: card.sport,
        matchup: `${card.awayTeam} @ ${card.homeTeam}`,
        startTime: card.startTime,
        displayed: displayedCardIds.has(card.id),
        failedFlags,
        diagnostics,
      };
    });
  }, [displayedCardIds, effectiveFilters, enrichedCards, viewMode]);

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
      {viewMode === 'game' && (
        <div className="mb-4 rounded-lg border border-white/10 bg-surface/30 px-3 py-2">
          <div className="flex items-center gap-2 flex-wrap">
            <button
              onClick={() => setShowLoadedDebugView((value) => !value)}
              className="px-3 py-1 text-xs font-semibold rounded border border-white/20 hover:border-white/40 hover:bg-surface/60 transition"
            >
              {showLoadedDebugView ? 'Hide Loaded Debug View' : 'Show Loaded Debug View'}
            </button>
            <span className="text-xs text-cloud/60">
              API games loaded: {games.length} | transformed cards: {enrichedCards.length} |
              displayed after filters: {filteredCards.length}
            </span>
          </div>

          {showLoadedDebugView && (
            <div className="mt-3 space-y-4 text-xs">
              <div className="rounded-md border border-white/10 bg-night/50 p-3">
                <div className="font-semibold text-cloud/70 mb-2">
                  Loaded API games ({games.length})
                </div>
                <div className="space-y-1 max-h-64 overflow-auto pr-1">
                  {games.map((game) => (
                    <div
                      key={`loaded-game-${game.gameId}`}
                      className="rounded border border-white/5 bg-surface/20 px-2 py-1 text-cloud/70"
                    >
                      <span className="font-medium text-cloud/80">{game.sport}</span>{' '}
                      <span>{game.awayTeam} @ {game.homeTeam}</span>{' '}
                      <span className="text-cloud/40">| gameId {game.gameId}</span>{' '}
                      <span className="text-cloud/40">| plays {game.plays.length}</span>{' '}
                      <span className="text-cloud/40">| status {game.status}</span>{' '}
                      <span className="text-cloud/40">| lifecycle {game.lifecycle_mode || 'unknown'}</span>
                      {!transformedGameIds.has(game.gameId) && (
                        <span className="ml-2 text-amber-400/70 font-mono text-[10px]">
                          [no-card: {getGameExclusionReason(game as Parameters<typeof getGameExclusionReason>[0]) ?? 'unknown'}]
                        </span>
                      )}
                    </div>
                  ))}
                </div>
              </div>

              <div className="rounded-md border border-white/10 bg-night/50 p-3">
                <div className="font-semibold text-cloud/70 mb-2">
                  Transformed card filter outcomes ({filterDebugRows.length})
                </div>
                <div className="space-y-1 max-h-80 overflow-auto pr-1">
                  {filterDebugRows.map((row) => (
                    <div
                      key={`filter-debug-${row.id}`}
                      className="rounded border border-white/5 bg-surface/20 px-2 py-1"
                    >
                      <div className="flex items-center gap-2 flex-wrap">
                        <span
                          className={`text-[10px] font-bold px-1.5 py-0.5 rounded ${
                            row.displayed
                              ? 'bg-emerald-700/40 text-emerald-100'
                              : 'bg-amber-700/40 text-amber-100'
                          }`}
                        >
                          {row.displayed ? 'DISPLAYED' : 'FILTERED_OUT'}
                        </span>
                        <span className="text-cloud/80 font-medium">{row.sport}</span>
                        <span className="text-cloud/70">{row.matchup}</span>
                        <span className="text-cloud/40">| gameId {row.gameId}</span>
                        <span className="text-cloud/40">| cardId {row.id}</span>
                      </div>
                      <div className="text-cloud/50 mt-1">
                        Start: {new Date(row.startTime).toLocaleString()} | Failed gates:{' '}
                        {row.failedFlags.length > 0 ? row.failedFlags.join(', ') : 'none'}
                      </div>
                      {row.diagnostics.length > 0 && (
                        <div className="text-amber-400/60 mt-0.5 font-mono text-[10px]">
                          {row.diagnostics.join(' | ')}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}
        </div>
      )}

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
            Debug diagnostics filter: {diagnosticCards.length} blocked{' '}
            {diagnosticFilter.sport} games
            {' — '}
            {DIAGNOSTIC_BUCKET_LABELS[diagnosticFilter.bucket]}
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
                .filter(([, b]) => countBlockedDiagnostics(b) > 0)
                .map(([sport, b]) => (
                  <div key={sport} className="flex gap-2 font-mono">
                    <span className="w-16">{sport}</span>
                    {b.noOdds > 0 && <span>no-odds:{b.noOdds}</span>}
                    {b.missingMapping > 0 && <span>no-map:{b.missingMapping}</span>}
                    {b.driverLoadFailed > 0 && (
                      <span>driver-fail:{b.driverLoadFailed}</span>
                    )}
                    {b.projectionOnly > 0 && <span>proj-only:{b.projectionOnly}</span>}
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
              key={`${game.gameId}-${play.cardType}-gameprops`}
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
              Blocked games — {DIAGNOSTIC_BUCKET_LABELS[diagnosticFilter.bucket]}
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
