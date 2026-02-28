/**
 * Filter presets for quick access
 * Based on FILTER-FEATURE.md design
 */

import type { GameFilters } from './filters';
import { DEFAULT_FILTERS } from './filters';

export interface FilterPreset {
  id: string;
  name: string;
  description: string;
  icon: string;
  filters: Partial<GameFilters>;
}

/**
 * Built-in Cheddar Presets
 */
export const FILTER_PRESETS: FilterPreset[] = [
  {
    id: 'all',
    name: 'Main View (FIRE+WATCH)',
    description: 'Default actionable board view',
    icon: '🎯',
    filters: DEFAULT_FILTERS,
  },
  {
    id: 'full_slate',
    name: 'Full Slate (Include PASS)',
    description: 'Show FIRE, WATCH, and PASS games',
    icon: '📋',
    filters: {
      ...DEFAULT_FILTERS,
      statuses: ['FIRE', 'WATCH', 'PASS'],
    },
  },
  {
    id: 'fire_tonight',
    name: 'FIRE Tonight',
    description: 'High-confidence plays starting today',
    icon: '🔥',
    filters: {
      ...DEFAULT_FILTERS,
      statuses: ['FIRE'],
      timeWindow: 'today',
      minTier: 'BEST',
      sortMode: 'start_time',
    },
  },
  {
    id: 'watch_next_4h',
    name: 'Watch List (Next 4h)',
    description: 'WATCH tier games in next 4 hours',
    icon: '👀',
    filters: {
      ...DEFAULT_FILTERS,
      statuses: ['FIRE', 'WATCH'],
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
    description: 'All NHL total picks',
    icon: '🏒',
    filters: {
      ...DEFAULT_FILTERS,
      sports: ['NHL'],
      markets: ['TOTAL'],
      onlyGamesWithPicks: true,
      sortMode: 'signal_strength',
    },
  },
  {
    id: 'avoid_risk',
    name: 'Avoid Fragility',
    description: 'Hide risky games (fragility/blowout)',
    icon: '🛡️',
    filters: {
      ...DEFAULT_FILTERS,
      hideFragility: true,
      hideBlowout: true,
      hideLowCoverage: true,
      sortMode: 'start_time',
    },
  },
  {
    id: 'coinflip_ml',
    name: 'Coinflip ML Value',
    description: 'Close ML odds (-120 to +120)',
    icon: '🪙',
    filters: {
      ...DEFAULT_FILTERS,
      markets: ['ML'],
      onlyGamesWithPicks: true,
      // Note: coinflip detection happens via tags
      sortMode: 'signal_strength',
    },
  },
  {
    id: 'next_2h',
    name: 'Starting Soon',
    description: 'Games starting in next 2 hours',
    icon: '⏰',
    filters: {
      ...DEFAULT_FILTERS,
      timeWindow: 'next_2h',
      sortMode: 'start_time',
    },
  },
  {
    id: 'best_only',
    name: 'BEST Tier Only',
    description: 'Only highest-tier drivers',
    icon: '⭐',
    filters: {
      ...DEFAULT_FILTERS,
      minTier: 'BEST',
      statuses: ['FIRE', 'WATCH'],
      sortMode: 'signal_strength',
    },
  },
];

/**
 * Get preset by ID
 */
export function getPreset(id: string): FilterPreset | undefined {
  return FILTER_PRESETS.find(p => p.id === id);
}

/**
 * Apply preset to get filter configuration
 */
export function applyPreset(presetId: string): GameFilters {
  const preset = getPreset(presetId);
  if (!preset) return DEFAULT_FILTERS;
  
  return {
    ...DEFAULT_FILTERS,
    ...preset.filters,
  };
}
