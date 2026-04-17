import type { GameFilters, ViewMode } from './filters';
import { resetFilters } from './filters';
import type { FilterPreset } from './presets';
import { getPreset, getPresetsForMode } from './presets';

type PresetHelperOptions = {
  now?: Date;
};

const FOUR_HOURS_MS = 4 * 60 * 60 * 1000;
const ROLLING_RANGE_TOLERANCE_MS = 60 * 1000;

const COMPARABLE_KEYS_BY_MODE: Record<ViewMode, string[]> = {
  game: [
    'sports',
    'statuses',
    'markets',
    'onlyGamesWithPicks',
    'hasClearPlay',
    'requireTotalProjection',
    'onlyWelcomeHome',
    'cardTypes',
    'minEdgePct',
    'minTier',
    'minConfidence',
    'hideFragility',
    'hideBlowout',
    'hideLowCoverage',
    'hideStaleOdds',
    'searchQuery',
    'timeWindow',
    'customTimeRange',
    'sortMode',
  ],
  props: [
    'sports',
    'statuses',
    'propStatGroups',
    'searchTarget',
    'searchQuery',
    'timeWindow',
    'customTimeRange',
    'sortMode',
  ],
  projections: [
    'sports',
    'statuses',
    'markets',
    'cardTypes',
    'searchQuery',
    'timeWindow',
    'customTimeRange',
    'sortMode',
  ],
};

function getNow(options?: PresetHelperOptions): Date {
  return options?.now ?? new Date();
}

function getWatchNext4hRange(options?: PresetHelperOptions) {
  const now = getNow(options);
  return {
    start: now.toISOString(),
    end: new Date(now.getTime() + FOUR_HOURS_MS).toISOString(),
  };
}

function materializePresetFilters(
  mode: ViewMode,
  preset: FilterPreset,
  options?: PresetHelperOptions,
): GameFilters {
  const defaults = resetFilters(mode);
  const filters = {
    ...defaults,
    ...preset.filters,
  } as GameFilters;

  if (preset.id === 'watch_next_4h') {
    return {
      ...filters,
      timeWindow: 'custom',
      customTimeRange: getWatchNext4hRange(options),
    } as GameFilters;
  }

  return filters;
}

function normalizeComparableValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return [...value].sort();
  }
  return value;
}

function valuesEqual(a: unknown, b: unknown): boolean {
  const left = normalizeComparableValue(a);
  const right = normalizeComparableValue(b);

  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right)) return false;
    if (left.length !== right.length) return false;
    return left.every((value, index) => value === right[index]);
  }

  if (
    left &&
    right &&
    typeof left === 'object' &&
    typeof right === 'object'
  ) {
    return JSON.stringify(left) === JSON.stringify(right);
  }

  return left === right;
}

function getFilterValue(filters: GameFilters, key: string): unknown {
  return (filters as unknown as Record<string, unknown>)[key];
}

function matchesRollingWatchNext4h(filters: GameFilters): boolean {
  if (filters.timeWindow !== 'custom' || !filters.customTimeRange) {
    return false;
  }

  const startMs = new Date(filters.customTimeRange.start).getTime();
  const endMs = new Date(filters.customTimeRange.end).getTime();
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return false;

  return Math.abs(endMs - startMs - FOUR_HOURS_MS) <= ROLLING_RANGE_TOLERANCE_MS;
}

export function buildPresetFilters(
  mode: ViewMode,
  presetId: string,
  options?: PresetHelperOptions,
): GameFilters {
  const preset = getPreset(mode, presetId);
  if (!preset) return resetFilters(mode);
  return materializePresetFilters(mode, preset, options);
}

export function doesPresetMatchFilters(
  mode: ViewMode,
  filters: GameFilters,
  preset: FilterPreset,
  options?: PresetHelperOptions,
): boolean {
  const target = materializePresetFilters(mode, preset, options);
  const comparableKeys = COMPARABLE_KEYS_BY_MODE[mode];

  for (const key of comparableKeys) {
    if (preset.id === 'watch_next_4h' && key === 'customTimeRange') {
      if (!matchesRollingWatchNext4h(filters)) return false;
      continue;
    }

    if (!valuesEqual(getFilterValue(filters, key), getFilterValue(target, key))) {
      return false;
    }
  }

  return true;
}

export function getActivePresetId(
  mode: ViewMode,
  filters: GameFilters,
  options?: PresetHelperOptions,
): string | null {
  return (
    getPresetsForMode(mode).find((preset) =>
      doesPresetMatchFilters(mode, filters, preset, options),
    )?.id ?? null
  );
}

export function togglePresetFilters(
  mode: ViewMode,
  filters: GameFilters,
  presetId: string,
  options?: PresetHelperOptions,
): GameFilters {
  const preset = getPreset(mode, presetId);
  if (!preset) return resetFilters(mode);
  if (doesPresetMatchFilters(mode, filters, preset, options)) {
    return resetFilters(mode);
  }
  return materializePresetFilters(mode, preset, options);
}
