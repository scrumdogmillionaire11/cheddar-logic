import { isPlayItem } from '@/lib/game-card/transform/legacy-repair';

import { inferMarketFromCardType } from './market-inference';
import type { GameRow, LifecycleMode, Play } from './route-handler';

const PROJECTION_ONLY_LINE_SOURCES = new Set<string>([
  'PROJECTION_FLOOR',
  'SYNTHETIC_FALLBACK',
]);
const MAIN_SURFACE_EXCLUDED_CARD_TYPES = new Set<string>([
  'mlb-f5',
  'mlb-f5-ml',
]);

function hasDisplayableOdds(row: GameRow): boolean {
  return (
    row.h2h_home !== null ||
    row.h2h_away !== null ||
    row.total !== null ||
    row.spread_home !== null ||
    row.spread_away !== null
  );
}

function isProjectionOnlyCoveragePlay(play: Play): boolean {
  const lineSource = play.line_source?.trim().toUpperCase() ?? null;
  const marketLineSource =
    play.market_context?.wager?.line_source?.trim().toUpperCase() ?? null;
  const projectionSource =
    play.prop_decision?.projection_source?.trim().toUpperCase() ?? null;

  return (
    play.basis === 'PROJECTION_ONLY' ||
    play.execution_status === 'PROJECTION_ONLY' ||
    play.prop_display_state === 'PROJECTION_ONLY' ||
    (lineSource != null && PROJECTION_ONLY_LINE_SOURCES.has(lineSource)) ||
    (marketLineSource != null &&
      PROJECTION_ONLY_LINE_SOURCES.has(marketLineSource)) ||
    projectionSource === 'SYNTHETIC_FALLBACK'
  );
}

function isMainSurfaceCoveragePlay(row: GameRow, play: Play): boolean {
  if (!isPlayItem(play as Parameters<typeof isPlayItem>[0], row.sport)) return false;
  if (play.market_type === 'INFO') return false;
  if (isProjectionOnlyCoveragePlay(play)) return false;

  const normalizedCardType = String(play.cardType || '').trim().toLowerCase();
  if (MAIN_SURFACE_EXCLUDED_CARD_TYPES.has(normalizedCardType)) return false;

  const inferredMarket =
    play.market_type ?? inferMarketFromCardType(play.cardType) ?? null;
  return inferredMarket !== 'FIRST_5_INNINGS';
}

function hasDisplayablePregamePlays(row: GameRow, plays: Play[]): boolean {
  return plays.some((play) => isMainSurfaceCoveragePlay(row, play));
}

export type GamesServiceRowsResult = {
  responseRows: GameRow[];
  deduplicatedRows: GameRow[];
  pregameRowsDroppedNoOddsNoPlays: number;
};

export function prepareGamesServiceRows(params: {
  rows: GameRow[];
  lifecycleMode: LifecycleMode;
  playsMap: Map<string, Play[]>;
}): GamesServiceRowsResult {
  const { rows, lifecycleMode, playsMap } = params;
  const pregameRowsDroppedNoOddsNoPlays =
    lifecycleMode === 'pregame'
      ? rows.reduce((count, row) => {
          const hasOdds = hasDisplayableOdds(row);
          const plays = playsMap.get(row.game_id) ?? [];
          const hasPlays = hasDisplayablePregamePlays(row, plays);
          const hasIngestFailure = Boolean(row.ingest_failure_reason_code);
          return !hasOdds && !hasPlays && !hasIngestFailure
            ? count + 1
            : count;
        }, 0)
      : 0;

  const responseRows =
    lifecycleMode === 'pregame'
      ? rows.filter((row) => {
          const hasOdds = hasDisplayableOdds(row);
          const plays = playsMap.get(row.game_id) ?? [];
          const hasPlays = hasDisplayablePregamePlays(row, plays);
          const hasIngestFailure = Boolean(row.ingest_failure_reason_code);
          return hasOdds || hasPlays || hasIngestFailure;
        })
      : rows;

  const deduplicatedRows = dedupeGamesByGameId({
    responseRows,
    playsMap,
  });

  return {
    responseRows,
    deduplicatedRows,
    pregameRowsDroppedNoOddsNoPlays,
  };
}

function dedupeGamesByGameId(params: {
  responseRows: GameRow[];
  playsMap: Map<string, Play[]>;
}): GameRow[] {
  const seen = new Map<string, GameRow>();
  for (const row of params.responseRows) {
    const existing = seen.get(row.game_id);
    if (!existing) {
      seen.set(row.game_id, row);
    } else {
      const existingKey = existing.odds_captured_at ?? existing.created_at;
      const rowKey = row.odds_captured_at ?? row.created_at;
      if (rowKey > existingKey) {
        seen.set(row.game_id, row);
      }
    }
  }
  return Array.from(seen.values());
}
