/**
 * Filter Panel Component
 * Provides UI for filtering game cards
 */

'use client';

import { useState } from 'react';
import type {
  GameFilters,
  PropStatGroup,
  PropSearchTarget,
  SortMode,
  ViewMode,
} from '@/lib/game-card/filters';
import { resetFilters } from '@/lib/game-card/filters';
import type {
  Sport,
  Market,
  DriverTier,
  ExpressionStatus,
} from '@/lib/types/game-card';
import { getPresetsForMode } from '@/lib/game-card/presets';

interface FilterPanelProps {
  filters: GameFilters;
  viewMode: ViewMode;
  onFiltersChange: (filters: GameFilters) => void;
  onReset: () => void;
  activeCount: number;
}

export default function FilterPanel({
  filters,
  viewMode,
  onFiltersChange,
  onReset,
  activeCount,
}: FilterPanelProps) {
  const [isExpanded, setIsExpanded] = useState(false);
  const now = new Date();

  const getWatchNext4hRange = () => ({
    start: now.toISOString(),
    end: new Date(now.getTime() + 4 * 60 * 60 * 1000).toISOString(),
  });

  const updateFilters = (updates: Partial<GameFilters>) => {
    onFiltersChange({ ...filters, ...updates });
  };

  const toggleSport = (sport: Sport) => {
    const sports = filters.sports.includes(sport)
      ? filters.sports.filter((s) => s !== sport)
      : [...filters.sports, sport];
    updateFilters({ sports });
  };

  const toggleStatus = (status: ExpressionStatus) => {
    const statuses = filters.statuses.includes(status)
      ? filters.statuses.filter((s) => s !== status)
      : [...filters.statuses, status];
    updateFilters({ statuses });
  };

  const toggleMarket = (market: Market) => {
    if (!('markets' in filters)) return;
    const markets = filters.markets.includes(market)
      ? filters.markets.filter((m) => m !== market)
      : [...filters.markets, market];
    updateFilters({ markets });
  };

  const togglePropStatGroup = (group: PropStatGroup) => {
    if (!('propStatGroups' in filters)) return;
    const propStatGroups = filters.propStatGroups.includes(group)
      ? filters.propStatGroups.filter((item) => item !== group)
      : [...filters.propStatGroups, group];
    updateFilters({ propStatGroups });
  };

  const doesPresetMatchCurrentFilters = (
    presetFilters: Partial<GameFilters>,
    presetId?: string,
  ) => {
    if (presetId === 'watch_next_4h') {
      if (filters.timeWindow !== 'custom' || !filters.customTimeRange) {
        return false;
      }

      const startMs = new Date(filters.customTimeRange.start).getTime();
      const endMs = new Date(filters.customTimeRange.end).getTime();
      const durationMs = endMs - startMs;
      const fourHoursMs = 4 * 60 * 60 * 1000;

      return Math.abs(durationMs - fourHoursMs) <= 60 * 1000;
    }

    return (Object.keys(presetFilters) as (keyof GameFilters)[]).every(
      (key) => {
        if (key === 'customTimeRange') {
          const presetRange = presetFilters.customTimeRange;
          const currentRange = filters.customTimeRange;

          if (!presetRange && !currentRange) return true;
          if (!presetRange || !currentRange) return false;

          return (
            presetRange.start === currentRange.start &&
            presetRange.end === currentRange.end
          );
        }

        const presetValue = presetFilters[key];
        const currentValue = filters[key];

        if (Array.isArray(presetValue)) {
          if (!Array.isArray(currentValue) || currentValue.length !== presetValue.length) {
            return false;
          }

          const presetSorted = [...presetValue].sort();
          const currentSorted = [...currentValue].sort();
          return presetSorted.every((value, index) => value === currentSorted[index]);
        }

        return presetValue === currentValue;
      },
    );
  };

  const applyPreset = (presetId: string) => {
    const preset = getPresetsForMode(viewMode).find((p) => p.id === presetId);
    if (preset) {
      if (doesPresetMatchCurrentFilters(preset.filters, preset.id)) {
        onFiltersChange(resetFilters(viewMode));
        return;
      }

      if (preset.id === 'watch_next_4h') {
        onFiltersChange({
          ...resetFilters(viewMode),
          ...preset.filters,
          timeWindow: 'custom',
          customTimeRange: getWatchNext4hRange(),
        });
        return;
      }

      onFiltersChange({ ...resetFilters(viewMode), ...preset.filters });
    }
  };

  const sportOptions: Sport[] = ['NHL', 'NBA', 'NCAAM', 'SOCCER', 'MLB', 'NFL'];
  const statusOptions: Array<{ value: ExpressionStatus; label: string }> = [
    { value: 'FIRE', label: 'PLAY' },
    { value: 'WATCH', label: 'LEAN' },
    { value: 'PASS', label: 'PASS' },
  ];
  const marketOptions: Market[] = ['ML', 'SPREAD', 'TOTAL'];
  const propMarketOptions: Array<{ value: PropStatGroup; label: string }> = [
    { value: 'SOG', label: 'Shots' },
    { value: 'PTS', label: 'Points' },
    { value: 'AST', label: 'Assists' },
    { value: 'REB', label: 'Rebounds' },
    { value: 'PRA', label: 'PRA' },
    { value: 'OTHER', label: 'Other' },
  ];
  const tierOptions: { value: DriverTier | undefined; label: string }[] = [
    { value: undefined, label: 'Any' },
    { value: 'BEST', label: 'BEST only' },
    { value: 'SUPER', label: 'SUPER+' },
    { value: 'WATCH', label: 'WATCH+' },
  ];
  const sortOptions: { value: SortMode; label: string }[] = [
    { value: 'start_time', label: 'Start Time' },
    { value: 'odds_updated', label: 'Odds Updated' },
    { value: 'signal_strength', label: 'Signal Strength' },
    { value: 'pick_score', label: 'Pick Score' },
  ];

  return (
    <div className="bg-surface/50 border border-white/10 rounded-lg mb-6">
      {/* Header */}
      <div className="flex items-center justify-between p-4 border-b border-white/10">
        <div className="flex items-center gap-3">
          <button
            onClick={() => setIsExpanded(!isExpanded)}
            className="flex items-center gap-2 text-lg font-semibold hover:text-white transition"
          >
            <span>{isExpanded ? '▼' : '▶'}</span>
            <span>Filters</span>
          </button>
          {activeCount > 0 && (
            <span className="px-2 py-1 text-xs font-bold bg-green-700/50 text-green-300 rounded">
              {activeCount} active
            </span>
          )}
        </div>
        <button
          onClick={onReset}
          className="px-3 py-1.5 text-sm rounded border border-white/20 hover:border-white/40 hover:bg-surface/50 transition"
        >
          Reset All
        </button>
      </div>

      {/* Expanded filter controls */}
      {isExpanded && (
        <div className="p-4 space-y-4">
          <div>
            <p className="text-xs uppercase tracking-widest text-cloud/40 mb-2 font-semibold">
              Quick Presets
            </p>
            <div className="flex flex-wrap gap-2">
              {getPresetsForMode(viewMode).map((preset) => {
                const isActive = doesPresetMatchCurrentFilters(
                  preset.filters,
                  preset.id,
                );

                return (
                  <button
                    key={preset.id}
                    onClick={() => applyPreset(preset.id)}
                    className={`px-3 py-1.5 text-sm rounded border transition ${
                      isActive
                        ? 'bg-blue-700/50 text-blue-200 border-blue-600/60'
                        : 'bg-white/5 hover:bg-white/10 border-white/10 hover:border-white/20'
                    }`}
                    title={preset.description}
                    aria-pressed={isActive}
                  >
                    <span className="mr-1.5">{preset.icon}</span>
                    {preset.name}
                  </button>
                );
              })}
            </div>
          </div>

          <div>
            <p className="text-xs uppercase tracking-widest text-cloud/40 mb-2 font-semibold">
              Quick Sort
            </p>
            <select
              value={filters.sortMode}
              onChange={(e) =>
                updateFilters({ sortMode: e.target.value as SortMode })
              }
              className="px-3 py-2 rounded bg-surface border border-white/10 hover:border-white/20"
            >
              {sortOptions.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
          </div>

          <div>
            <p className="text-xs uppercase tracking-widest text-cloud/40 mb-2 font-semibold">
              Quick Sports
            </p>
            <div className="flex flex-wrap gap-2">
              {sportOptions.map((sport) => (
                <button
                  key={`quick-sport-${sport}`}
                  onClick={() => toggleSport(sport)}
                  className={`px-3 py-1.5 text-sm rounded border transition ${
                    filters.sports.includes(sport)
                      ? 'bg-blue-700/50 text-blue-200 border-blue-600/60'
                      : 'bg-white/5 border-white/10 hover:border-white/20'
                  }`}
                >
                  {sport}
                </button>
              ))}
            </div>
          </div>

          {viewMode !== 'projections' && (
          <div>
            <p className="text-xs uppercase tracking-widest text-cloud/40 mb-2 font-semibold">
              {viewMode === 'props' ? 'Quick Prop Markets' : 'Quick Markets'}
            </p>
            {viewMode === 'props' && 'propStatGroups' in filters ? (
              <div className="flex flex-wrap gap-2">
                {propMarketOptions.map((option) => (
                  <button
                    key={`quick-prop-market-${option.value}`}
                    onClick={() => togglePropStatGroup(option.value)}
                    className={`px-3 py-1.5 text-sm rounded border transition ${
                      filters.propStatGroups.includes(option.value)
                        ? 'bg-orange-700/50 text-orange-200 border-orange-600/60'
                        : 'bg-white/5 border-white/10 hover:border-white/20'
                    }`}
                  >
                    {option.label}
                  </button>
                ))}
              </div>
            ) : (
              <div className="flex flex-wrap gap-2">
                {marketOptions.map((market) => (
                  <button
                    key={`quick-market-${market}`}
                    onClick={() => toggleMarket(market)}
                    className={`px-3 py-1.5 text-sm rounded border transition ${
                      'markets' in filters && filters.markets.includes(market)
                        ? 'bg-orange-700/50 text-orange-200 border-orange-600/60'
                        : 'bg-white/5 border-white/10 hover:border-white/20'
                    }`}
                  >
                    {market}
                  </button>
                ))}
              </div>
            )}
          </div>
          )}

          {/* Status Selection — hidden in projections mode (informational, all statuses always shown) */}
          {viewMode !== 'projections' && (
          <div>
            <p className="text-xs uppercase tracking-widest text-cloud/40 mb-2 font-semibold">
              Actionability
            </p>
            <div className="flex flex-wrap gap-2">
              {statusOptions.map(({ value, label }) => (
                <button
                  key={value}
                  onClick={() => toggleStatus(value)}
                  className={`px-3 py-1.5 text-sm rounded border transition ${
                    filters.statuses.includes(value)
                      ? value === 'FIRE'
                        ? 'bg-green-700/50 text-green-300 border-green-600/60'
                        : value === 'WATCH'
                          ? 'bg-yellow-700/50 text-yellow-300 border-yellow-600/60'
                          : 'bg-white/20 text-cloud border-white/30'
                      : 'bg-white/5 border-white/10 hover:border-white/20'
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
          )}

          {/* Driver Strength (Game mode only) */}
          {viewMode === 'game' && 'minTier' in filters && (
            <div>
              <p className="text-xs uppercase tracking-widest text-cloud/40 mb-2 font-semibold">
                Minimum Tier
              </p>
              <select
                value={filters.minTier || ''}
                onChange={(e) =>
                  updateFilters({
                    minTier: e.target.value
                      ? (e.target.value as DriverTier)
                      : undefined,
                  })
                }
                className="px-3 py-2 rounded bg-surface border border-white/10 hover:border-white/20"
              >
                {tierOptions.map((opt) => (
                  <option key={opt.label} value={opt.value || ''}>
                    {opt.label}
                  </option>
                ))}
              </select>
            </div>
          )}

          {/* Search */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <p className="text-xs uppercase tracking-widest text-cloud/40 font-semibold">
                {viewMode === 'props' ? 'Search Players' : 'Search Teams'}
              </p>
              {viewMode === 'props' && 'searchTarget' in filters && (
                <select
                  value={filters.searchTarget}
                  onChange={(e) =>
                    updateFilters({
                      searchTarget: e.target.value as PropSearchTarget,
                    })
                  }
                  className="px-2 py-1 text-xs rounded bg-surface border border-white/10 hover:border-white/20"
                >
                  <option value="player">Player</option>
                  <option value="team">Team</option>
                  <option value="opponent">Opponent</option>
                </select>
              )}
            </div>
            <input
              type="text"
              value={filters.searchQuery}
              onChange={(e) => updateFilters({ searchQuery: e.target.value })}
              placeholder={
                viewMode === 'props'
                  ? 'Search by player name...'
                  : 'Search by team name...'
              }
              className="w-full px-3 py-2 rounded bg-surface border border-white/10 hover:border-white/20 focus:border-white/40 focus:outline-none"
            />
          </div>
        </div>
      )}
    </div>
  );
}
