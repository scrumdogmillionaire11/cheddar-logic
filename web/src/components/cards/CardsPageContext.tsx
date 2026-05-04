'use client';

import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from 'react';
import {
  applyFilters,
  evaluateCardFilter,
  getActiveFilterCount,
  getDefaultFilters,
  resetFilters,
} from '@/lib/game-card/filters';
import { transformGames, transformPropGames } from '@/lib/game-card/transform/index';
import {
  enrichCards,
  hasEdgeVerification,
  hasProxyCap,
} from '@/lib/game-card/tags';
import { classifySportDiagnosticBucket } from '@/lib/game-card/pass-classification';
import { createTimeoutSignal } from '@/lib/network/timeout-signal';
import {
  buildStaleAssetErrorMessage,
  extractNextStaticAssetPath,
  formatStaleAssetUserMessage,
  isStaleNextStaticAssetFailure,
  STALE_ASSET_RELOAD_GUARD_KEY,
  stringifyUnknownError,
} from '@/lib/stale-asset-recovery';
import type {
  CardsPageActions,
  CardsPageContextValue,
  CardsPageState,
  CardsUiAction,
  CardsUiState,
  GuardrailBreakdownEntry,
} from './types';
import {
  CHUNK_ERROR_LOG_CODE,
  CLIENT_DEFAULT_BACKOFF_MS,
  CLIENT_FETCH_TIMEOUT_MS,
  CLIENT_MIN_FETCH_INTERVAL_MS,
  CLIENT_POLL_INTERVAL_MS,
  FETCH_ERROR_LOG_CODE,
  LIFECYCLE_SESSION_KEY,
  bumpReason,
  countBySport,
  createDropReasonCounts,
  createDroppedMeta,
  createGuardrailBreakdownEntry,
  formatSportCounts,
  getCardDebugMeta,
  getEtDayKey,
  getFirstDropReason,
  getLifecycleAwareFilters,
  groupCardsByEtDate,
  parseRetryAfterMs,
  resolveLifecycleModeFromUrlAndStorage,
  resolvePrimaryTotalProjectionPlay,
  summarizeNonJsonBody,
  createProjectionFilterCard,
  deriveOnePModelCallFromReasons,
  hasProjectedTotal,
  filterPropCards,
  matchesProjectionSportFilter,
  isFullGameTotalsCallPlay,
} from './shared';
import type { ApiResponse, GameData, LifecycleMode } from './types';

const CardsPageContext = createContext<CardsPageContextValue | null>(null);

let globalGamesFetchInFlight = false;
let globalGamesLastFetchAt = 0;
let globalGamesBlockedUntil = 0;
let globalGamesRequestLifecycle: LifecycleMode | null = null;
let globalGamesLastEffectiveLifecycle: LifecycleMode | null = null;

/**
 * Returns true for HTTP status codes that represent transient failures where
 * preserving the last-known games state is preferable to clearing it.
 * Returns false for non-recoverable errors (auth, not found, bad request)
 * that warrant clearing stale state.
 */
function isRecoverableHttpError(status: number): boolean {
  return status >= 500 || status === 429;
}

function cardsUiReducer(state: CardsUiState, action: CardsUiAction): CardsUiState {
  switch (action.type) {
    case 'set_filters':
      return { ...state, filters: action.filters };
    case 'reset_filters':
      return { ...state, filters: action.filters };
    case 'set_view_mode':
      return {
        ...state,
        viewMode: action.viewMode,
        filters: action.filters,
      };
    case 'set_lifecycle_mode':
      return {
        ...state,
        lifecycleMode: action.lifecycleMode,
      };
    case 'set_diagnostic_filter':
      return {
        ...state,
        diagnosticFilter: action.diagnosticFilter,
      };
    default:
      return state;
  }
}

function getInitialUiState(): CardsUiState {
  return {
    viewMode: 'game',
    lifecycleMode: 'pregame',
    filters: getDefaultFilters('game'),
    diagnosticFilter: null,
  };
}

export function CardsPageProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  const [uiState, dispatch] = useReducer(cardsUiReducer, undefined, getInitialUiState);
  const [games, setGames] = useState<GameData[]>([]);
  const [projectionRescueItems, setProjectionRescueItems] = useState<
    Array<{ game: GameData; play: GameData['plays'][number] }>
  >([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const isInitialLoad = useRef(true);
  const latestLifecycleModeRef = useRef<LifecycleMode>(uiState.lifecycleMode);
  const lifecycleRetryTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );
  const initialLoadRetryTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const initialLoadRetryAttemptsRef = useRef(0);
  const hasHydratedUrlStateRef = useRef(false);
  const projectionRescueAttemptedRef = useRef(false);
  const diagnosticsEnabled =
    process.env.NODE_ENV !== 'production' &&
    process.env.NEXT_PUBLIC_ENABLE_CARDS_DIAGNOSTICS === 'true';
  // Hydration safety is handled by the hasMounted guard in CardsModeTabs,
  // which renders an empty container on SSR and first client pass regardless
  // of this value. This const is therefore safe to read directly at render time.
  // NOTE: all env files (including .env.vercel) are now aligned to true.
  const propsEnabled = process.env.NEXT_PUBLIC_ENABLE_PLAYER_PROPS === 'true';
  const {
    sports: activeSports,
    timeWindow: activeTimeWindow,
    customTimeRange: activeCustomTimeRange,
  } = uiState.filters;

  const effectiveFilters = useMemo(
    () =>
      getLifecycleAwareFilters(
        uiState.filters,
        uiState.viewMode,
        uiState.lifecycleMode,
      ),
    [uiState.filters, uiState.viewMode, uiState.lifecycleMode],
  );

  const { enrichedCards, filteredCards, propCards, totalCardsInView } = useMemo(() => {
    if (uiState.viewMode === 'props') {
      const propGameCards = transformPropGames(
        games as Parameters<typeof transformPropGames>[0],
      );
      const filteredPropCards = filterPropCards(propGameCards, effectiveFilters);

      if (process.env.NODE_ENV !== 'production') {
        console.info('[props-debug]', {
          total_prop_games: propGameCards.length,
          filtered_prop_games: filteredPropCards.length,
          total_prop_plays: propGameCards.reduce(
            (sum, g) => sum + g.propPlays.length,
            0,
          ),
          filtered_prop_plays: filteredPropCards.reduce(
            (sum, g) => sum + g.propPlays.length,
            0,
          ),
          sample_prop_game: propGameCards[0]
            ? {
                gameId: propGameCards[0].gameId,
                sport: propGameCards[0].sport,
                homeTeam: propGameCards[0].homeTeam,
                awayTeam: propGameCards[0].awayTeam,
                propPlays_count: propGameCards[0].propPlays.length,
                sample_play: propGameCards[0].propPlays[0],
              }
            : null,
        });
      }

      return {
        enrichedCards: [],
        filteredCards: [],
        propCards: filteredPropCards,
        totalCardsInView: propGameCards.length,
      };
    }

    const transformed = transformGames(games as Parameters<typeof transformGames>[0]);
    const enriched = enrichCards(transformed);
    const filtered = applyFilters(enriched, effectiveFilters, uiState.viewMode);

    return {
      enrichedCards: enriched,
      filteredCards: filtered,
      propCards: [],
      totalCardsInView: enriched.length,
    };
  }, [games, effectiveFilters, uiState.viewMode]);

  const groupedByDate = useMemo(
    () =>
      groupCardsByEtDate(filteredCards as CardsPageState['filteredCards'], (card) =>
        card.startTime,
      ),
    [filteredCards],
  );

  const propGroupedByDate = useMemo(
    () => groupCardsByEtDate(propCards, (card) => card.gameTimeUtc),
    [propCards],
  );

  const projectionItems = useMemo(() => {
    if (uiState.viewMode !== 'projections') return [];

    const seenProjectionKeys = new Set<string>();
    const dedupedItems: Array<{ game: GameData; play: GameData['plays'][number] }> = [];

    // Task 1 data-flow trace:
    // 1) /api/cards emits payloadData for projection surface types (api/cards/route.ts).
    // 2) fetchGamesData stores those rows into `games` in this provider.
    // 3) This `projectionItems` builder selects nhl-pace-1p / mlb-f5 / mlb-f5-ml
    //    and feeds CardsList -> ProjectionCard.
    // Intentionally include PASS/FIRE/WATCH so projection cards always surface.
    for (const game of games) {
      if (!matchesProjectionSportFilter(game, effectiveFilters)) continue;

      const projectionPlays = game.plays.filter(
        (p) =>
          p.cardType === 'nhl-pace-1p' ||
          p.cardType === 'nhl-1p-call' ||
          p.cardType === 'mlb-f5' ||
          p.cardType === 'mlb-f5-ml',
      );
      if (projectionPlays.length === 0) continue;

      for (const play of projectionPlays) {
        const projectionKey = [
          String(game.sport || '').toUpperCase(),
          String(game.awayTeam || '').trim().toUpperCase(),
          String(game.homeTeam || '').trim().toUpperCase(),
          String(game.gameTimeUtc || ''),
          String(play.cardType || '').trim().toLowerCase(),
        ].join('|');

        // Guard against intermittent duplicate payload variants for the same
        // matchup/time/card type reaching the projection surface.
        if (seenProjectionKeys.has(projectionKey)) continue;
        seenProjectionKeys.add(projectionKey);
        dedupedItems.push({ game, play });
      }
    }

    return dedupedItems;
  }, [effectiveFilters, games, uiState.viewMode]);

  const projectionItemsForDisplay =
    projectionItems.length > 0 ? projectionItems : projectionRescueItems;

  const displayedCardsInView =
    uiState.viewMode === 'props'
      ? propCards.length
      : uiState.viewMode === 'projections'
        ? projectionItemsForDisplay.length
        : filteredCards.length;

  const totalCardsInCurrentView =
    uiState.viewMode === 'projections'
      ? projectionItemsForDisplay.length
      : totalCardsInView;

  const activeFilterCount = getActiveFilterCount(effectiveFilters, uiState.viewMode);
  const todayEtKey = useMemo(() => getEtDayKey(new Date()), []);

  const traceStats = useMemo(() => {
    const fetchedBySport = countBySport(games);
    const transformedBySport = countBySport(enrichedCards);
    const displayedBySport = countBySport(
      filteredCards as CardsPageState['filteredCards'],
    );

    const fetchedTodayBySport = countBySport(
      games.filter((game) => getEtDayKey(game.gameTimeUtc) === todayEtKey),
    );
    const transformedTodayBySport = countBySport(
      enrichedCards.filter((card) => getEtDayKey(card.startTime) === todayEtKey),
    );
    const displayedTodayBySport = countBySport(
      (filteredCards as CardsPageState['filteredCards']).filter(
        (card) => getEtDayKey(card.startTime) === todayEtKey,
      ),
    );

    return {
      fetchedTotal: games.length,
      transformedTotal: enrichedCards.length,
      displayedTotal: filteredCards.length,
      fetchedBySport,
      transformedBySport,
      displayedBySport,
      fetchedTodayBySport,
      transformedTodayBySport,
      displayedTodayBySport,
    };
  }, [games, enrichedCards, filteredCards, todayEtKey]);

  const guardrailStats = useMemo(() => {
    const triggered = {
      edge_sanity_triggered: 0,
      proxy_cap_triggered: 0,
      proxy_blocked: 0,
      high_edge_non_total_blocked: 0,
      driver_load_failures: 0,
      exact_wager_mismatch: 0,
      market_price_missing: 0,
    };
    const outcome = {
      fire_to_watch: 0,
      watch_to_pass: 0,
      fire_to_pass: 0,
      bet_removed: 0,
    };
    const breakdownBySportMarketBook: Record<string, GuardrailBreakdownEntry> = {};

    for (const card of enrichedCards) {
      const play = card.play;
      const tags = play?.tags ?? [];
      const edgeTriggered = hasEdgeVerification(card);
      const proxyTriggered = hasProxyCap(card);
      const market = play?.market_type ?? play?.market ?? 'UNKNOWN';
      const book = play?.bet?.book ?? 'unknown';
      const source = play?.priceSource ?? play?.lineSource ?? 'unknown';
      const key = `${card.sport}|${market}|${book}|${source}`;

      if (!breakdownBySportMarketBook[key]) {
        breakdownBySportMarketBook[key] = createGuardrailBreakdownEntry();
      }
      const bucket = breakdownBySportMarketBook[key];
      const reasonCodes = new Set([
        ...(Array.isArray(play?.reason_codes) ? play.reason_codes : []),
        ...(Array.isArray(play?.decision_v2?.price_reason_codes)
          ? play.decision_v2.price_reason_codes
          : []),
      ]);

      if (edgeTriggered) {
        triggered.edge_sanity_triggered += 1;
        bucket.triggered.edge_sanity_triggered += 1;
      }
      if (proxyTriggered) {
        triggered.proxy_cap_triggered += 1;
        bucket.triggered.proxy_cap_triggered += 1;
      }
      if (reasonCodes.has('PROXY_EDGE_BLOCKED')) {
        triggered.proxy_blocked += 1;
        bucket.triggered.proxy_blocked += 1;
      }
      if (
        reasonCodes.has('LINE_NOT_CONFIRMED') ||
        reasonCodes.has('EDGE_RECHECK_PENDING') ||
        reasonCodes.has('PRICE_SYNC_PENDING')
      ) {
        triggered.high_edge_non_total_blocked += 1;
        bucket.triggered.high_edge_non_total_blocked += 1;
      }
      if (
        reasonCodes.has('PASS_DRIVER_LOAD_FAILED') ||
        reasonCodes.has('PASS_MISSING_DRIVER_INPUTS')
      ) {
        triggered.driver_load_failures += 1;
        bucket.triggered.driver_load_failures += 1;
      }
      if (reasonCodes.has('EXACT_WAGER_MISMATCH')) {
        triggered.exact_wager_mismatch += 1;
        bucket.triggered.exact_wager_mismatch += 1;
      }
      if (
        reasonCodes.has('MARKET_PRICE_MISSING') ||
        reasonCodes.has('PASS_MARKET_PRICE_MISSING') ||
        reasonCodes.has('MISSING_DATA_NO_ODDS')
      ) {
        triggered.market_price_missing += 1;
        bucket.triggered.market_price_missing += 1;
      }

      if (tags.includes('OUTCOME_FIRE_TO_WATCH')) {
        outcome.fire_to_watch += 1;
        bucket.outcome.fire_to_watch += 1;
      }
      if (tags.includes('OUTCOME_WATCH_TO_PASS')) {
        outcome.watch_to_pass += 1;
        bucket.outcome.watch_to_pass += 1;
      }
      if (tags.includes('OUTCOME_FIRE_TO_PASS')) {
        outcome.fire_to_pass += 1;
        bucket.outcome.fire_to_pass += 1;
      }
      if (tags.includes('OUTCOME_BET_REMOVED')) {
        outcome.bet_removed += 1;
        bucket.outcome.bet_removed += 1;
      }
    }

    return { triggered, outcome, breakdownBySportMarketBook };
  }, [enrichedCards]);

  const dropTraceStats = useMemo(() => {
    const droppedByReason = createDropReasonCounts();
    const droppedByReasonBySport: Record<string, ReturnType<typeof createDropReasonCounts>> = {};
    const droppedMetaBySport: Record<string, ReturnType<typeof createDroppedMeta>> = {};
    const evaluateEffectiveCardFilter = (
      filterCard: (typeof enrichedCards)[number],
      f: typeof effectiveFilters,
    ) =>
      uiState.viewMode === 'projections'
        ? evaluateCardFilter(filterCard, f, 'projections')
        : evaluateCardFilter(filterCard, f, uiState.viewMode);

    for (const card of enrichedCards) {
      const predicate = evaluateEffectiveCardFilter(card, effectiveFilters);
      if (predicate.passes) continue;

      const reason = getFirstDropReason(predicate.flags);
      bumpReason(droppedByReason, reason);

      const sportKey = (card.sport || 'UNKNOWN').toUpperCase();
      if (!droppedByReasonBySport[sportKey]) {
        droppedByReasonBySport[sportKey] = createDropReasonCounts();
      }
      bumpReason(droppedByReasonBySport[sportKey], reason);

      if (!droppedMetaBySport[sportKey]) {
        droppedMetaBySport[sportKey] = createDroppedMeta();
      }

      const meta = droppedMetaBySport[sportKey];
      const cardMeta = getCardDebugMeta(card);

      meta.games += 1;
      meta.playCount += cardMeta.playCount;
      meta.hasAnyPlay += cardMeta.hasAnyPlay ? 1 : 0;
      meta.hasBettable += cardMeta.hasBettable ? 1 : 0;
      meta.hasBlockedTotals += cardMeta.hasBlockedTotals ? 1 : 0;
      meta.hasDataError += cardMeta.hasDataError ? 1 : 0;
      meta.playStatusCounts.FIRE += cardMeta.playStatusCounts.FIRE;
      meta.playStatusCounts.WATCH += cardMeta.playStatusCounts.WATCH;
      meta.playStatusCounts.PASS += cardMeta.playStatusCounts.PASS;

      for (const market of cardMeta.playMarkets) {
        meta.playMarkets[market] = (meta.playMarkets[market] || 0) + 1;
      }
    }

    return {
      droppedByReason,
      droppedByReasonBySport,
      droppedMetaBySport,
    };
  }, [effectiveFilters, enrichedCards, uiState.viewMode]);

  const sportDiagnostics = useMemo(() => {
    const visibleIds = new Set(
      (filteredCards as CardsPageState['filteredCards']).map((card) => card.id),
    );
    const result: CardsPageState['sportDiagnostics'] = {};
    for (const card of enrichedCards) {
      if (visibleIds.has(card.id)) continue;
      const sportKey = (card.sport || 'UNKNOWN').toUpperCase();
      if (!result[sportKey]) {
        result[sportKey] = {
          missingMapping: 0,
          driverLoadFailed: 0,
          noOdds: 0,
          noProjection: 0,
          projectionOnly: 0,
        };
      }
      const buckets = result[sportKey];
      const bucket = classifySportDiagnosticBucket(card);
      buckets[bucket] += 1;
    }
    return result;
  }, [enrichedCards, filteredCards]);

  const diagnosticCards = useMemo(() => {
    if (!uiState.diagnosticFilter) return [];
    const visibleIds = new Set(
      (filteredCards as CardsPageState['filteredCards']).map((card) => card.id),
    );
    const filtered = enrichedCards.filter((card) => {
      if (visibleIds.has(card.id)) return false;
      if ((card.sport || 'UNKNOWN').toUpperCase() !== uiState.diagnosticFilter?.sport) {
        return false;
      }
      return classifySportDiagnosticBucket(card) === uiState.diagnosticFilter.bucket;
    });
    // In diagnostics mode, attach drop reason metadata for surface visibility
    if (!diagnosticsEnabled) return filtered;
    return filtered.map((card) => ({
      ...card,
      _drop_reason_code:
        card.play?.transform_meta?.drop_reason?.drop_reason_code ??
        card.play?.pass_reason_code ??
        null,
      _drop_reason_layer: card.play?.transform_meta?.drop_reason?.drop_reason_layer ?? null,
      _reason_code_set: Array.from(
        new Set([
          ...(Array.isArray(card.play?.reason_codes) ? card.play.reason_codes : []),
          ...(card.play?.transform_meta?.drop_reason?.drop_reason_code
            ? [card.play.transform_meta.drop_reason.drop_reason_code]
            : []),
        ]),
      ),
    }));
  }, [diagnosticsEnabled, enrichedCards, filteredCards, uiState.diagnosticFilter]);

  const hiddenDataErrors = useMemo(
    () =>
      Object.values(dropTraceStats.droppedMetaBySport).reduce(
        (sum, meta) => sum + (meta?.hasDataError ?? 0),
        0,
      ),
    [dropTraceStats],
  );

  const hiddenDataErrorCards = useMemo(() => {
    const visibleIds = new Set(
      (filteredCards as CardsPageState['filteredCards']).map((card) => card.id),
    );
    return enrichedCards
      .filter((card) => {
        if (visibleIds.has(card.id)) return false;
        const mis: string[] = card.play?.transform_meta?.missing_inputs ?? [];
        const onlyMissingPlay =
          mis.length > 0 &&
          mis.every((inp) => inp === 'play') &&
          !card.play?.reason_codes?.includes('MISSING_DATA_DRIVERS');
        if (onlyMissingPlay) return false;
        return Boolean(
          card.play?.transform_meta?.quality === 'BROKEN' ||
            card.play?.reason_codes?.includes('PASS_DATA_ERROR') ||
            card.play?.gates?.some((gate) => gate.code === 'PASS_DATA_ERROR'),
        );
      })
      .slice(0, 25);
  }, [enrichedCards, filteredCards]);

  useEffect(() => {
    latestLifecycleModeRef.current = uiState.lifecycleMode;
  }, [uiState.lifecycleMode]);

  useEffect(() => {
    const handleChunkFailure = (
      message: string,
      source: 'error' | 'unhandledrejection',
    ) => {
      if (!isStaleNextStaticAssetFailure(message)) return;
      const chunkPath = extractNextStaticAssetPath(message);
      console.error(`[${CHUNK_ERROR_LOG_CODE}]`, {
        source,
        message,
        chunk_path: chunkPath,
      });

      if (typeof window === 'undefined') return;
      const alreadyReloaded =
        window.sessionStorage.getItem(STALE_ASSET_RELOAD_GUARD_KEY) === '1';

      if (!alreadyReloaded) {
        window.sessionStorage.setItem(STALE_ASSET_RELOAD_GUARD_KEY, '1');
        window.location.reload();
        return;
      }

      setError(formatStaleAssetUserMessage(message));
      setGames([]);
    };

    const onError = (event: Event) => {
      const errorEvent = event as ErrorEvent;
      handleChunkFailure(buildStaleAssetErrorMessage(errorEvent), 'error');
    };

    const onUnhandledRejection = (event: PromiseRejectionEvent) => {
      handleChunkFailure(
        stringifyUnknownError(event.reason),
        'unhandledrejection',
      );
    };

    window.addEventListener('error', onError, true);
    window.addEventListener('unhandledrejection', onUnhandledRejection);

    return () => {
      window.removeEventListener('error', onError, true);
      window.removeEventListener('unhandledrejection', onUnhandledRejection);
    };
  }, []);

  const gamesFetchKey = `${uiState.lifecycleMode}:${uiState.viewMode}`;

  useEffect(() => {
    let cancelled = false;
    initialLoadRetryAttemptsRef.current = 0;

    const fetchGames = async () => {
      const now = Date.now();
      const requestedLifecycleMode = latestLifecycleModeRef.current;
      const effectiveLifecycleMode =
        requestedLifecycleMode === 'active' && uiState.viewMode === 'projections'
          ? 'pregame'
          : requestedLifecycleMode;
      const wasInitialLoad = isInitialLoad.current;
      let failedRecoverably = false;

      if (globalGamesFetchInFlight) {
        console.debug('[cards] Skipping fetch - global request already in flight', {
          requestedLifecycleMode,
          effectiveLifecycleMode,
          inflightLifecycleMode: globalGamesRequestLifecycle,
        });
        const shouldRetryForLifecycleChange =
          globalGamesRequestLifecycle !== requestedLifecycleMode;
        if (
          shouldRetryForLifecycleChange &&
          lifecycleRetryTimeoutRef.current === null
        ) {
          lifecycleRetryTimeoutRef.current = setTimeout(() => {
            lifecycleRetryTimeoutRef.current = null;
            globalGamesLastFetchAt = 0;
            void fetchGames();
          }, 150);
        }
        if (!cancelled) {
          setLoading(shouldRetryForLifecycleChange);
        }
        return;
      }

      if (globalGamesBlockedUntil > now) {
        const retryAfterMs = globalGamesBlockedUntil - now;
        const retryAfterSec = Math.max(1, Math.ceil(retryAfterMs / 1000));
        if (!cancelled) {
          setError(
            `Server rate limited. Retrying in ${retryAfterSec} seconds...`,
          );
          // Keep spinner active on initial load so the page doesn't go blank.
          setLoading(wasInitialLoad);
        }
        // On initial load, schedule an auto-retry once the block expires.
        // Without this the page stays blank until the 60s interval fires.
        if (wasInitialLoad && initialLoadRetryTimeoutRef.current === null) {
          initialLoadRetryTimeoutRef.current = setTimeout(() => {
            initialLoadRetryTimeoutRef.current = null;
            void fetchGames();
          }, retryAfterMs + 100); // +100ms buffer past block expiry
        }
        return;
      }

      // On initial mount always fetch regardless of the module-level throttle.
      // globalGamesLastFetchAt persists across soft Next.js navigations; a fresh
      // component mount must not be silenced by a poll that ran in a prior
      // component lifetime — that would leave games=[] with no retry.
      if (
        !wasInitialLoad &&
        globalGamesLastFetchAt &&
        now - globalGamesLastFetchAt < CLIENT_MIN_FETCH_INTERVAL_MS &&
        globalGamesLastEffectiveLifecycle === effectiveLifecycleMode
      ) {
        console.debug('[cards] Skipping fetch - throttled');
        if (!cancelled) {
          setLoading(false);
        }
        return;
      }

      try {
        globalGamesFetchInFlight = true;
        globalGamesRequestLifecycle = requestedLifecycleMode;
        globalGamesLastEffectiveLifecycle = effectiveLifecycleMode;
        globalGamesLastFetchAt = now;

        if (isInitialLoad.current) {
          setLoading(true);
        }

        const timeoutHandle = createTimeoutSignal(CLIENT_FETCH_TIMEOUT_MS);
        const lifecycleQuery =
          requestedLifecycleMode === 'active' ? '?lifecycle=active' : '';
        const response = await fetch(`/api/games${lifecycleQuery}`, {
          ...(timeoutHandle.signal ? { signal: timeoutHandle.signal } : {}),
          cache: 'no-store',
        }).finally(() => {
          timeoutHandle.cleanup();
        });

        if (response.status === 429) {
          const retryAfterMs =
            parseRetryAfterMs(response.headers.get('Retry-After')) ??
            CLIENT_DEFAULT_BACKOFF_MS;
          globalGamesBlockedUntil = Date.now() + retryAfterMs;
          const retryAfterSec = Math.max(1, Math.ceil(retryAfterMs / 1000));
          console.warn('[cards] Rate limited, backing off', {
            retryAfterSec,
            is_initial_load: wasInitialLoad,
          });
          // Mark recoverable so the finally block schedules an expedited retry
          // via initialLoadRetryTimeoutRef. Without this the page stays blank
          // on initial load until the 60s poll interval fires.
          if (wasInitialLoad) {
            failedRecoverably = true;
          }
          if (!cancelled) {
            setError(
              `Server rate limited. Retrying in ${retryAfterSec} seconds...`,
            );
          }
          return;
        }

        globalGamesBlockedUntil = 0;
        const contentType = (
          response.headers.get('content-type') || ''
        ).toLowerCase();
        const responseText = await response.text();
        let data: ApiResponse | null = null;
        if (contentType.includes('application/json')) {
          try {
            data = JSON.parse(responseText) as ApiResponse;
          } catch {
            data = null;
          }
        }

        if (!response.ok) {
          const nonJsonDetail =
            data?.error ||
            `HTTP ${response.status} ${response.statusText}${
              responseText ? `: ${summarizeNonJsonBody(responseText)}` : ''
            }`;
          console.error('[cards] /api/games fetch failed', {
            status: response.status,
            error: nonJsonDetail,
            is_initial_load: wasInitialLoad,
            lifecycle: requestedLifecycleMode,
            effective_lifecycle: effectiveLifecycleMode,
          });
          if (wasInitialLoad && isRecoverableHttpError(response.status)) {
            failedRecoverably = true;
          }
          if (!cancelled) {
            setError(nonJsonDetail);
            if (wasInitialLoad && !isRecoverableHttpError(response.status)) {
              setGames([]);
            }
          }
          return;
        }

        if (!data) {
          if (!cancelled) {
            setError(
              `Invalid API response format (expected JSON, got ${contentType || 'unknown content-type'})`,
            );
            if (isInitialLoad.current) {
              setGames([]);
            }
          }
          return;
        }

        if (!data.success) {
          if (!cancelled) {
            setError(data.error || 'Failed to fetch games');
            if (isInitialLoad.current) {
              setGames([]);
            }
          }
          return;
        }

        const nextGames = Array.isArray(data.data) ? data.data : [];
        const gamesMode = response.headers.get('X-Games-Mode') ?? 'unknown';
        const gamesCount = response.headers.get('X-Games-Count') ?? String(nextGames.length);
        if (gamesMode !== 'full' && gamesMode !== 'unknown') {
          console.warn('[cards] /api/games degraded response', {
            response_mode: gamesMode,
            data_count: gamesCount,
            lifecycle: requestedLifecycleMode,
            effective_lifecycle: effectiveLifecycleMode,
          });
        }
        if (!cancelled) {
          setGames(nextGames);
          setError(null);
        }
      } catch (err) {
        const isAbort =
          err instanceof Error &&
          (err.name === 'AbortError' || err.name === 'TimeoutError');
        const fallbackMessage = stringifyUnknownError(err);
        const message =
          err instanceof Error
            ? err.message || fallbackMessage
            : fallbackMessage;
        const logPayload = {
          message,
          error_name: err instanceof Error ? err.name : 'UnknownError',
          is_initial_load: wasInitialLoad,
          lifecycle: requestedLifecycleMode,
          effective_lifecycle: effectiveLifecycleMode,
          timeout_ms: CLIENT_FETCH_TIMEOUT_MS,
          is_abort: isAbort,
        };
        const serializedLogPayload = JSON.stringify(logPayload);
        if (isAbort) {
          console.warn(`[${FETCH_ERROR_LOG_CODE}] ${serializedLogPayload}`);
        } else {
          console.error(`[${FETCH_ERROR_LOG_CODE}] ${serializedLogPayload}`);
        }
        if (wasInitialLoad) {
          // Network errors and timeouts are recoverable on initial load
          failedRecoverably = true;
        }
        if (!cancelled && !isAbort) {
          setError(message);
        }
      } finally {
        globalGamesFetchInFlight = false;
        globalGamesRequestLifecycle = null;
        if (!cancelled) {
          const MAX_INITIAL_RETRIES = 4;
          if (
            wasInitialLoad &&
            failedRecoverably &&
            initialLoadRetryAttemptsRef.current < MAX_INITIAL_RETRIES
          ) {
            // Keep loading spinner + isInitialLoad=true, schedule expedited retry
            // instead of waiting the full 60s poll interval.
            initialLoadRetryAttemptsRef.current += 1;
            console.warn('[cards] Initial load failed, scheduling retry', {
              attempt: initialLoadRetryAttemptsRef.current,
              max: MAX_INITIAL_RETRIES,
              retry_in_ms: CLIENT_MIN_FETCH_INTERVAL_MS,
            });
            initialLoadRetryTimeoutRef.current = setTimeout(() => {
              initialLoadRetryTimeoutRef.current = null;
              globalGamesLastFetchAt = 0;
              void fetchGames();
            }, CLIENT_MIN_FETCH_INTERVAL_MS);
            // Keep setLoading(true) and isInitialLoad=true
          } else {
            setLoading(false);
            isInitialLoad.current = false;
          }
        }
      }
    };

    void fetchGames();
    const interval = setInterval(() => {
      if (document.visibilityState !== 'visible') return;
      void fetchGames();
    }, CLIENT_POLL_INTERVAL_MS);

    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        void fetchGames();
      }
    };

    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      cancelled = true;
      if (lifecycleRetryTimeoutRef.current) {
        clearTimeout(lifecycleRetryTimeoutRef.current);
        lifecycleRetryTimeoutRef.current = null;
      }
      if (initialLoadRetryTimeoutRef.current) {
        clearTimeout(initialLoadRetryTimeoutRef.current);
        initialLoadRetryTimeoutRef.current = null;
      }
      clearInterval(interval);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [gamesFetchKey]);

  useEffect(() => {
    if (uiState.viewMode !== 'projections') {
      projectionRescueAttemptedRef.current = false;
      setProjectionRescueItems([]);
      return;
    }

    const hasProjectionRows = games.some((game) =>
      Array.isArray(game.plays) &&
      game.plays.some((play) => {
        const cardType = String(play.cardType || '').toLowerCase();
        return (
          cardType === 'nhl-pace-1p' ||
          cardType === 'nhl-1p-call' ||
          cardType === 'mlb-f5' ||
          cardType === 'mlb-f5-ml'
        );
      }),
    );

    if (hasProjectionRows) {
      projectionRescueAttemptedRef.current = false;
      setProjectionRescueItems([]);
      return;
    }

    if (projectionRescueAttemptedRef.current) return;
    projectionRescueAttemptedRef.current = true;

    let cancelled = false;
    const rescueProjectionFetch = async () => {
      try {
        const timeoutHandle = createTimeoutSignal(CLIENT_FETCH_TIMEOUT_MS);
        const response = await fetch('/api/games', {
          ...(timeoutHandle.signal ? { signal: timeoutHandle.signal } : {}),
          cache: 'no-store',
        }).finally(() => {
          timeoutHandle.cleanup();
        });

        if (!response.ok) return;
        const data = (await response.json()) as ApiResponse;
        if (!data.success || !Array.isArray(data.data)) return;

        const seenProjectionKeys = new Set<string>();
        const dedupedItems: Array<{ game: GameData; play: GameData['plays'][number] }> = [];
        for (const game of data.data as GameData[]) {
          for (const play of game.plays || []) {
            if (
              play.cardType !== 'nhl-pace-1p' &&
              play.cardType !== 'nhl-1p-call' &&
              play.cardType !== 'mlb-f5' &&
              play.cardType !== 'mlb-f5-ml'
            ) {
              continue;
            }
            const projectionKey = [
              String(game.sport || '').toUpperCase(),
              String(game.awayTeam || '').trim().toUpperCase(),
              String(game.homeTeam || '').trim().toUpperCase(),
              String(game.gameTimeUtc || ''),
              String(play.cardType || '').trim().toLowerCase(),
            ].join('|');
            if (seenProjectionKeys.has(projectionKey)) continue;
            seenProjectionKeys.add(projectionKey);
            dedupedItems.push({ game, play });
          }
        }

        if (!cancelled) {
          setGames(data.data);
          setProjectionRescueItems(dedupedItems);
          setError(null);
        }
      } catch (err) {
        console.warn('[cards] projections rescue fetch failed', {
          message: stringifyUnknownError(err),
        });
      }
    };

    void rescueProjectionFetch();
    return () => {
      cancelled = true;
    };
  }, [games, uiState.viewMode]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (hasHydratedUrlStateRef.current) return;
    hasHydratedUrlStateRef.current = true;

    const params = new URLSearchParams(window.location.search);
    const resolvedLifecycleMode = resolveLifecycleModeFromUrlAndStorage();
    if (uiState.lifecycleMode !== resolvedLifecycleMode) {
      globalGamesLastFetchAt = 0;
      latestLifecycleModeRef.current = resolvedLifecycleMode;
      setLoading(true);
      dispatch({ type: 'set_lifecycle_mode', lifecycleMode: resolvedLifecycleMode });
    }

    const modeParam = params.get('mode');
    if (modeParam === 'props' && propsEnabled) {
      const defaults = getDefaultFilters('props');
      dispatch({
        type: 'set_view_mode',
        viewMode: 'props',
        filters: {
          ...defaults,
          sports: activeSports,
          timeWindow: activeTimeWindow,
          customTimeRange: activeCustomTimeRange,
        },
      });
    } else if (modeParam === 'projections') {
      const defaults = getDefaultFilters('projections');
      dispatch({
        type: 'set_view_mode',
        viewMode: 'projections',
        filters: defaults,
      });
    }
  }, [
    activeCustomTimeRange,
    activeSports,
    activeTimeWindow,
    propsEnabled,
    uiState.lifecycleMode,
  ]);

  useEffect(() => {
    if (propsEnabled || uiState.viewMode !== 'props') return;
    dispatch({
      type: 'set_view_mode',
      viewMode: 'game',
      filters: getDefaultFilters('game'),
    });
  }, [propsEnabled, uiState.viewMode]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const url = new URL(window.location.href);
    if (uiState.viewMode === 'game') {
      url.searchParams.delete('mode');
    } else {
      url.searchParams.set('mode', uiState.viewMode);
    }
    if (uiState.lifecycleMode === 'pregame') {
      url.searchParams.delete('lifecycle');
    } else {
      url.searchParams.set('lifecycle', uiState.lifecycleMode);
    }
    window.sessionStorage.setItem(LIFECYCLE_SESSION_KEY, uiState.lifecycleMode);
    window.history.replaceState({}, '', url.toString());
  }, [uiState.lifecycleMode, uiState.viewMode]);

  useEffect(() => {
    const isVerboseCardsTrace =
      process.env.NEXT_PUBLIC_CARDS_TRACE_VERBOSE === 'true';
    if (loading || !diagnosticsEnabled || !isVerboseCardsTrace) return;

    const displayedMetaBySport: Record<string, ReturnType<typeof createDroppedMeta>> = {};
    for (const card of filteredCards as CardsPageState['filteredCards']) {
      const sportKey = (card.sport || 'UNKNOWN').toUpperCase();
      if (!displayedMetaBySport[sportKey]) {
        displayedMetaBySport[sportKey] = createDroppedMeta();
      }

      const meta = displayedMetaBySport[sportKey];
      const cardMeta = getCardDebugMeta(card);

      meta.games += 1;
      meta.playCount += cardMeta.playCount;
      meta.hasAnyPlay += cardMeta.hasAnyPlay ? 1 : 0;
      meta.hasBettable += cardMeta.hasBettable ? 1 : 0;
      meta.hasBlockedTotals += cardMeta.hasBlockedTotals ? 1 : 0;
      meta.hasDataError += cardMeta.hasDataError ? 1 : 0;
      meta.playStatusCounts.FIRE += cardMeta.playStatusCounts.FIRE;
      meta.playStatusCounts.WATCH += cardMeta.playStatusCounts.WATCH;
      meta.playStatusCounts.PASS += cardMeta.playStatusCounts.PASS;

      for (const market of cardMeta.playMarkets) {
        meta.playMarkets[market] = (meta.playMarkets[market] || 0) + 1;
      }
    }

    console.info('[cards-trace]', {
      todayEt: todayEtKey,
      fetchedTotal: traceStats.fetchedTotal,
      transformedTotal: traceStats.transformedTotal,
      displayedTotal: traceStats.displayedTotal,
      fetchedBySport: traceStats.fetchedBySport,
      transformedBySport: traceStats.transformedBySport,
      displayedBySport: traceStats.displayedBySport,
      fetchedTodayBySport: traceStats.fetchedTodayBySport,
      transformedTodayBySport: traceStats.transformedTodayBySport,
      displayedTodayBySport: traceStats.displayedTodayBySport,
      dropTraceStats,
      displayedMetaBySport,
      guardrail_telemetry: {
        triggered: guardrailStats.triggered,
        outcome: guardrailStats.outcome,
        breakdown_by_sport_market_book:
          guardrailStats.breakdownBySportMarketBook,
      },
      filters: uiState.filters,
    });
    console.warn(
      '[🚫 FILTERED OUT - REASONS BY SPORT]',
      dropTraceStats.droppedByReasonBySport,
    );
    console.warn(
      '[🚫 FILTERED OUT - META BY SPORT]',
      dropTraceStats.droppedMetaBySport,
    );
    console.info('[✅ DISPLAYED - META BY SPORT]', displayedMetaBySport);
    console.info(
      '[🧾 FILTERED OUT - REASON SETS]',
      diagnosticCards.map((card) => ({
        id: card.id,
        sport: card.sport,
        game: `${card.awayTeam} @ ${card.homeTeam}`,
        drop_reason_code:
          card.play?.transform_meta?.drop_reason?.drop_reason_code ??
          card.play?.pass_reason_code ??
          null,
        drop_reason_layer:
          card.play?.transform_meta?.drop_reason?.drop_reason_layer ?? null,
        reason_codes: Array.isArray(card.play?.reason_codes)
          ? card.play.reason_codes
          : [],
      })),
    );
  }, [
    diagnosticCards,
    diagnosticsEnabled,
    dropTraceStats,
    filteredCards,
    guardrailStats,
    loading,
    todayEtKey,
    traceStats,
    uiState.filters,
  ]);

  const gameMap = useMemo(
    () => new Map(games.map((game) => [game.gameId, game])),
    [games],
  );

  const actions = useMemo<CardsPageActions>(
    () => ({
      onFiltersChange: (filters) => {
        dispatch({ type: 'set_filters', filters });
      },
      onResetFilters: () => {
        dispatch({
          type: 'reset_filters',
          filters: resetFilters(uiState.viewMode),
        });
      },
      onModeChange: (nextMode) => {
          if (nextMode === uiState.viewMode) return;
        if (nextMode === 'props' && !propsEnabled) return;
        const defaults = getDefaultFilters(nextMode);
        const nextFilters =
          nextMode === 'projections'
            ? defaults
            : {
                ...defaults,
                sports: uiState.filters.sports,
                timeWindow: uiState.filters.timeWindow,
                customTimeRange: uiState.filters.customTimeRange,
              };
        dispatch({
          type: 'set_view_mode',
          viewMode: nextMode,
          filters: nextFilters,
        });
      },
      onLifecycleModeChange: (nextMode) => {
        if (nextMode === uiState.lifecycleMode) return;
        globalGamesLastFetchAt = 0;
        if (lifecycleRetryTimeoutRef.current) {
          clearTimeout(lifecycleRetryTimeoutRef.current);
          lifecycleRetryTimeoutRef.current = null;
        }
        dispatch({ type: 'set_lifecycle_mode', lifecycleMode: nextMode });
        setLoading(true);
      },
      onDiagnosticFilterChange: (nextDiagnosticFilter) => {
        const diagnosticFilter =
          typeof nextDiagnosticFilter === 'function'
            ? nextDiagnosticFilter(uiState.diagnosticFilter)
            : nextDiagnosticFilter;
        dispatch({
          type: 'set_diagnostic_filter',
          diagnosticFilter,
        });
      },
    }),
    [propsEnabled, uiState.diagnosticFilter, uiState.filters, uiState.lifecycleMode, uiState.viewMode],
  );

  const state = useMemo<CardsPageState>(
    () => ({
      ...uiState,
      games,
      gameMap,
      loading,
      error,
      diagnosticsEnabled,
      propsEnabled,
      effectiveFilters,
      enrichedCards,
      filteredCards,
      propCards,
      totalCardsInView: totalCardsInCurrentView,
      groupedByDate,
      propGroupedByDate,
      projectionItems: projectionItemsForDisplay,
      displayedCardsInView,
      activeFilterCount,
      todayEtKey,
      traceStats,
      guardrailStats,
      dropTraceStats,
      sportDiagnostics,
      diagnosticCards,
      hiddenDataErrors,
      hiddenDataErrorCards,
    }),
    [
      activeFilterCount,
      diagnosticCards,
      diagnosticsEnabled,
      displayedCardsInView,
      dropTraceStats,
      effectiveFilters,
      enrichedCards,
      error,
      filteredCards,
      gameMap,
      games,
      groupedByDate,
      guardrailStats,
      hiddenDataErrorCards,
      hiddenDataErrors,
      loading,
      projectionItemsForDisplay,
      propCards,
      propGroupedByDate,
      propsEnabled,
      sportDiagnostics,
      todayEtKey,
      totalCardsInCurrentView,
      traceStats,
      uiState,
    ],
  );

  const value = useMemo(
    () => ({
      state,
      actions,
    }),
    [actions, state],
  );

  return (
    <CardsPageContext.Provider value={value}>
      {children}
    </CardsPageContext.Provider>
  );
}

export function useCardsPageContext() {
  const value = useContext(CardsPageContext);
  if (!value) {
    throw new Error('useCardsPageContext must be used within CardsPageProvider');
  }
  return value;
}

export function useCardsPageState() {
  return useCardsPageContext().state;
}

export function useCardsPageActions() {
  return useCardsPageContext().actions;
}

export { formatSportCounts, resolvePrimaryTotalProjectionPlay, deriveOnePModelCallFromReasons, hasProjectedTotal, isFullGameTotalsCallPlay };
