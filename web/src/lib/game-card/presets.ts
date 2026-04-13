/**
 * Filter presets for quick access
 * Based on FILTER-FEATURE.md design
 */

import type { GameFilters, ViewMode } from './filters';
import type { ExpressionStatus } from '@/lib/types';
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
    name: 'Main View (PLAY + SLIGHT EDGE)',
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
    id: 'watch_next_4h',
    name: 'Watch List (Next 4h)',
    description: 'Slight edges (LEAN only) starting within 4 hours',
    icon: '👀',
    filters: {
      ...DEFAULT_FILTERS_BY_MODE.game,
      statuses: ['WATCH'] as ExpressionStatus[],
      timeWindow: 'custom',
      customTimeRange: {
        start: new Date().toISOString(),
        end: new Date(Date.now() + 4 * 60 * 60 * 1000).toISOString(),
      },
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
    description: 'All games starting in next 2 hours (including no plays)',
    icon: '⏰',
    filters: {
      ...DEFAULT_FILTERS_BY_MODE.game,
      statuses: FIRE_WATCH_PASS,
      timeWindow: 'next_2h',
      sortMode: 'start_time',
    },
  },
  {
    id: 'best_only',
    name: 'PLAY Tier Only',
    description: 'PLAY tier calls only — no slight edges, includes tomorrow',
    icon: '⭐',
    filters: {
      ...DEFAULT_FILTERS_BY_MODE.game,
      statuses: FIRE_ONLY,
      sortMode: 'start_time',
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
    id: 'props_blocks',
    name: 'Blocks Focus',
    description: 'NHL blocked shot props only',
    icon: '🛡️',
    filters: {
      ...DEFAULT_FILTERS_BY_MODE.props,
      propStatGroups: ['BLOCKS'],
      sortMode: 'signal_strength',
    },
  },
  {
    id: 'props_strikeouts',
    name: 'Strikeouts Focus',
    description: 'MLB pitcher strikeout props only',
    icon: '⚾',
    filters: {
      ...DEFAULT_FILTERS_BY_MODE.props,
      propStatGroups: ['K'],
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
    name: 'All Game Props',
    description: 'All NHL 1P projections and MLB F5 totals',
    icon: '📊',
    filters: { ...DEFAULT_PROJECTIONS_FILTERS },
  },
  {
    id: 'proj_today',
    name: 'Tonight',
    description: 'Game props for tonight',
    icon: '📅',
    filters: { ...DEFAULT_PROJECTIONS_FILTERS, timeWindow: 'today' as const },
  },
  {
    id: 'proj_active',
    name: 'OVER/UNDER only',
    description: 'Only directional calls (OVER/UNDER)',
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
