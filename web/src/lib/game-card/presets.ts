/**
 * Filter presets for quick access
 * Based on FILTER-FEATURE.md design
 */

import type { GameFilters, ViewMode } from './filters';
import type { ExpressionStatus } from '@/lib/types/game-card';
import { DEFAULT_FILTERS_BY_MODE, DEFAULT_PROJECTIONS_FILTERS } from './filters';

export interface FilterPreset {
  id: string;
  name: string;
  description: string;
  icon: string;
  filters: Partial<GameFilters>;
}

const ENABLE_WELCOME_HOME =
  process.env.NEXT_PUBLIC_ENABLE_WELCOME_HOME === 'true';

const FIRE_WATCH: ExpressionStatus[] = ['FIRE', 'WATCH'];
const FIRE_WATCH_PASS: ExpressionStatus[] = ['FIRE', 'WATCH', 'PASS'];
const FIRE_ONLY: ExpressionStatus[] = ['FIRE'];

const WELCOME_HOME_PRESET: FilterPreset = {
  id: 'welcome_home',
  name: 'Welcome Home Fade',
  description: 'Road trip fatigue plays (NBA/NHL)',
  icon: '🏠',
  filters: {
    ...DEFAULT_FILTERS_BY_MODE.game,
    onlyWelcomeHome: true,
    statuses: FIRE_WATCH,
    sortMode: 'signal_strength',
  },
};

/**
 * Built-in Cheddar Presets
 */
const GAME_PRESETS: FilterPreset[] = [
  {
    id: 'all',
    name: 'Main View (PLAY + LEAN)',
    description: 'Default actionable board view',
    icon: '🎯',
    filters: DEFAULT_FILTERS_BY_MODE.game,
  },
  {
    id: 'full_slate',
    name: 'Full Slate (Include PASS)',
    description: 'Show PLAY, LEAN, and PASS games',
    icon: '📋',
    filters: {
      ...DEFAULT_FILTERS_BY_MODE.game,
      statuses: FIRE_WATCH_PASS,
      markets: ['ML', 'SPREAD', 'TOTAL'],
    },
  },
  {
    id: 'play_tonight',
    name: 'PLAY Tonight',
    description: 'High-confidence plays starting today',
    icon: '🔥',
    filters: {
      ...DEFAULT_FILTERS_BY_MODE.game,
      statuses: FIRE_ONLY,
      timeWindow: 'today',
      minTier: 'BEST',
      sortMode: 'start_time',
    },
  },
  {
    id: 'watch_next_4h',
    name: 'Watch List (Next 4h)',
    description: 'LEAN games in next 4 hours',
    icon: '👀',
    filters: {
      ...DEFAULT_FILTERS_BY_MODE.game,
      statuses: FIRE_WATCH,
      timeWindow: 'custom',
      customTimeRange: {
        start: new Date().toISOString(),
        end: new Date(Date.now() + 4 * 60 * 60 * 1000).toISOString(),
      },
      minTier: 'WATCH',
      sortMode: 'start_time',
    },
  },
  {
    id: 'nhl_totals',
    name: 'NHL Totals Only',
    description: 'All NHL totals with model projection context',
    icon: '🏒',
    filters: {
      ...DEFAULT_FILTERS_BY_MODE.game,
      sports: ['NHL'],
      markets: ['TOTAL'],
      statuses: FIRE_WATCH_PASS,
      onlyGamesWithPicks: false,
      requireTotalProjection: true,
      sortMode: 'signal_strength',
    },
  },
  {
    id: 'next_2h',
    name: 'Starting Soon',
    description: 'Games starting in next 2 hours',
    icon: '⏰',
    filters: {
      ...DEFAULT_FILTERS_BY_MODE.game,
      timeWindow: 'next_2h',
      sortMode: 'start_time',
    },
  },
  {
    id: 'best_only',
    name: 'PLAY Tier Only',
    description: 'Only highest-tier drivers',
    icon: '⭐',
    filters: {
      ...DEFAULT_FILTERS_BY_MODE.game,
      minTier: 'BEST',
      statuses: FIRE_WATCH,
      sortMode: 'signal_strength',
    },
  },
  {
    id: '1p_totals',
    name: '1P Totals View',
    description: 'NHL 1P pace projections',
    icon: '📊',
    filters: {
      ...DEFAULT_FILTERS_BY_MODE.game,
      cardTypes: ['nhl-pace-1p'],
      sortMode: 'signal_strength',
    },
  },
  {
    id: 'ncaam_ft_trend',
    name: 'NCAAM FT% Trend',
    description: 'Spread calls for FT% edge (>75 vs <75) with total < 160',
    icon: '🎯',
    filters: {
      ...DEFAULT_FILTERS_BY_MODE.game,
      sports: ['NCAAM'],
      markets: ['SPREAD'],
      statuses: FIRE_WATCH,
      cardTypes: ['ncaam-ft-trend', 'ncaam-ft-spread'],
      sortMode: 'signal_strength',
    },
  },
  ...(ENABLE_WELCOME_HOME ? [WELCOME_HOME_PRESET] : []),
];

const PROPS_PRESETS: FilterPreset[] = [
  {
    id: 'props_best',
    name: 'Best Props',
    description: 'Top qualified props only',
    icon: '🎯',
    filters: {
      ...DEFAULT_FILTERS_BY_MODE.props,
      statuses: FIRE_WATCH,
      sortMode: 'signal_strength',
    },
  },
  {
    id: 'props_shots',
    name: 'Shots Focus',
    description: 'Player shot-based props only',
    icon: '🎯',
    filters: {
      ...DEFAULT_FILTERS_BY_MODE.props,
      propStatGroups: ['SOG'],
      sortMode: 'signal_strength',
    },
  },
  {
    id: 'props_points',
    name: 'Points Focus',
    description: 'Points/PRA style props',
    icon: '📈',
    filters: {
      ...DEFAULT_FILTERS_BY_MODE.props,
      propStatGroups: ['PTS', 'PRA'],
      sortMode: 'signal_strength',
    },
  },
];

const PROJECTIONS_PRESETS: FilterPreset[] = [
  {
    id: 'proj_all',
    name: 'All 1P',
    description: 'All NHL first-period pace projections',
    icon: '📊',
    filters: { ...DEFAULT_PROJECTIONS_FILTERS },
  },
  {
    id: 'proj_today',
    name: 'Tonight',
    description: 'First-period projections for tonight',
    icon: '📅',
    filters: { ...DEFAULT_PROJECTIONS_FILTERS, timeWindow: 'today' as const },
  },
  {
    id: 'proj_active',
    name: 'OVER/UNDER only',
    description: 'Only games with a directional 1P call',
    icon: '🎯',
    filters: {
      ...DEFAULT_PROJECTIONS_FILTERS,
      statuses: ['FIRE', 'WATCH'] as ExpressionStatus[],
    },
  },
];

export const PRESETS_BY_MODE: Record<ViewMode, FilterPreset[]> = {
  game: GAME_PRESETS,
  props: PROPS_PRESETS,
  projections: PROJECTIONS_PRESETS,
};

/**
 * Get preset by ID
 */
export function getPresetsForMode(mode: ViewMode): FilterPreset[] {
  return PRESETS_BY_MODE[mode] || [];
}

export function getPreset(
  mode: ViewMode,
  id: string,
): FilterPreset | undefined {
  return getPresetsForMode(mode).find((p) => p.id === id);
}

/**
 * Apply preset to get filter configuration
 */
export function applyPreset(mode: ViewMode, presetId: string): GameFilters {
  const preset = getPreset(mode, presetId);
  if (!preset) return DEFAULT_FILTERS_BY_MODE[mode];

  return {
    ...DEFAULT_FILTERS_BY_MODE[mode],
    ...preset.filters,
  };
}
