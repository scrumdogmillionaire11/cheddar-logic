/**
 * Filter Panel Component
 * Provides UI for filtering game cards
 */

'use client';

import { useState } from 'react';
import type { GameFilters, SortMode } from '@/lib/game-card/filters';
import { resetFilters } from '@/lib/game-card/filters';
import type { Sport, Market, DriverTier, ExpressionStatus } from '@/lib/types/game-card';
import { FILTER_PRESETS } from '@/lib/game-card/presets';

interface FilterPanelProps {
  filters: GameFilters;
  onFiltersChange: (filters: GameFilters) => void;
  onReset: () => void;
  activeCount: number;
}

export default function FilterPanel({
  filters,
  onFiltersChange,
  onReset,
  activeCount,
}: FilterPanelProps) {
  const [isExpanded, setIsExpanded] = useState(false);

  const updateFilters = (updates: Partial<GameFilters>) => {
    onFiltersChange({ ...filters, ...updates });
  };

  const toggleSport = (sport: Sport) => {
    const sports = filters.sports.includes(sport)
      ? filters.sports.filter(s => s !== sport)
      : [...filters.sports, sport];
    updateFilters({ sports });
  };

  const toggleStatus = (status: ExpressionStatus) => {
    const statuses = filters.statuses.includes(status)
      ? filters.statuses.filter(s => s !== status)
      : [...filters.statuses, status];
    updateFilters({ statuses });
  };

  const toggleMarket = (market: Market) => {
    const markets = filters.markets.includes(market)
      ? filters.markets.filter(m => m !== market)
      : [...filters.markets, market];
    updateFilters({ markets });
  };

  const doesPresetMatchCurrentFilters = (presetFilters: Partial<GameFilters>) => {
    return (Object.keys(presetFilters) as (keyof GameFilters)[]).every(key => {
      if (key === 'customTimeRange') {
        const presetRange = presetFilters.customTimeRange;
        const currentRange = filters.customTimeRange;

        if (!presetRange && !currentRange) return true;
        if (!presetRange || !currentRange) return false;

        return presetRange.start === currentRange.start && presetRange.end === currentRange.end;
      }

      const presetValue = presetFilters[key];
      const currentValue = filters[key];

      if (Array.isArray(presetValue)) {
        if (!Array.isArray(currentValue) || currentValue.length !== presetValue.length) {
          return false;
        }
        return presetValue.every((value, index) => value === currentValue[index]);
      }

      return presetValue === currentValue;
    });
  };

  const applyPreset = (presetId: string) => {
    const preset = FILTER_PRESETS.find(p => p.id === presetId);
    if (preset) {
      if (doesPresetMatchCurrentFilters(preset.filters)) {
        onFiltersChange(resetFilters());
        return;
      }

      onFiltersChange({ ...resetFilters(), ...preset.filters });
    }
  };

  const sportOptions: Sport[] = ['NHL', 'NBA', 'NCAAM', 'SOCCER'];
  const statusOptions: ExpressionStatus[] = ['FIRE', 'WATCH', 'PASS'];
  const marketOptions: Market[] = ['ML', 'SPREAD', 'TOTAL'];
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

      {/* Presets (always visible) */}
      <div className="p-4 border-b border-white/10">
        <p className="text-xs uppercase tracking-widest text-cloud/40 mb-2 font-semibold">
          Quick Presets
        </p>
        <div className="flex flex-wrap gap-2">
          {FILTER_PRESETS.map(preset => {
            const isActive = doesPresetMatchCurrentFilters(preset.filters);

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

      {/* Expanded filter controls */}
      {isExpanded && (
        <div className="p-4 space-y-4">
          {/* Sport Selection */}
          <div>
            <p className="text-xs uppercase tracking-widest text-cloud/40 mb-2 font-semibold">
              Sports
            </p>
            <div className="flex flex-wrap gap-2">
              {sportOptions.map(sport => (
                <button
                  key={sport}
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

          {/* Status Selection */}
          <div>
            <p className="text-xs uppercase tracking-widest text-cloud/40 mb-2 font-semibold">
              Actionability
            </p>
            <div className="flex flex-wrap gap-2">
              {statusOptions.map(status => (
                <button
                  key={status}
                  onClick={() => toggleStatus(status)}
                  className={`px-3 py-1.5 text-sm rounded border transition ${
                    filters.statuses.includes(status)
                      ? status === 'FIRE'
                        ? 'bg-green-700/50 text-green-300 border-green-600/60'
                        : status === 'WATCH'
                        ? 'bg-yellow-700/50 text-yellow-300 border-yellow-600/60'
                        : 'bg-white/20 text-cloud border-white/30'
                      : 'bg-white/5 border-white/10 hover:border-white/20'
                  }`}
                >
                  {status}
                </button>
              ))}
            </div>
          </div>

          {/* Market Selection */}
          <div>
            <p className="text-xs uppercase tracking-widest text-cloud/40 mb-2 font-semibold">
              Markets
            </p>
            <div className="flex flex-wrap gap-2">
              {marketOptions.map(market => (
                <button
                  key={market}
                  onClick={() => toggleMarket(market)}
                  className={`px-3 py-1.5 text-sm rounded border transition ${
                    filters.markets.includes(market)
                      ? 'bg-orange-700/50 text-orange-200 border-orange-600/60'
                      : 'bg-white/5 border-white/10 hover:border-white/20'
                  }`}
                >
                  {market}
                </button>
              ))}
            </div>
            <label className="flex items-center gap-2 mt-2 text-sm text-cloud/70">
              <input
                type="checkbox"
                checked={filters.onlyGamesWithPicks}
                onChange={e => updateFilters({ onlyGamesWithPicks: e.target.checked })}
                className="rounded"
              />
              Only games with picks
            </label>
            <label className="flex items-center gap-2 mt-2 text-sm text-cloud/70">
              <input
                type="checkbox"
                checked={filters.hasClearPlay}
                onChange={e => updateFilters({ hasClearPlay: e.target.checked })}
                className="rounded"
              />
              Has clear play
            </label>
          </div>

          {/* Time Window */}
          <div>
            <p className="text-xs uppercase tracking-widest text-cloud/40 mb-2 font-semibold">
              Time Window
            </p>
            <div className="flex flex-wrap gap-2">
              <button
                onClick={() => updateFilters({ timeWindow: undefined })}
                className={`px-3 py-1.5 text-sm rounded border transition ${
                  !filters.timeWindow
                    ? 'bg-blue-700/50 text-blue-200 border-blue-600/60'
                    : 'bg-white/5 border-white/10 hover:border-white/20'
                }`}
              >
                All
              </button>
              <button
                onClick={() => updateFilters({ timeWindow: 'next_2h' })}
                className={`px-3 py-1.5 text-sm rounded border transition ${
                  filters.timeWindow === 'next_2h'
                    ? 'bg-blue-700/50 text-blue-200 border-blue-600/60'
                    : 'bg-white/5 border-white/10 hover:border-white/20'
                }`}
              >
                Next 2 Hours
              </button>
              <button
                onClick={() => updateFilters({ timeWindow: 'today' })}
                className={`px-3 py-1.5 text-sm rounded border transition ${
                  filters.timeWindow === 'today'
                    ? 'bg-blue-700/50 text-blue-200 border-blue-600/60'
                    : 'bg-white/5 border-white/10 hover:border-white/20'
                }`}
              >
                Today
              </button>
            </div>
          </div>

          {/* Driver Strength */}
          <div>
            <p className="text-xs uppercase tracking-widest text-cloud/40 mb-2 font-semibold">
              Minimum Tier
            </p>
            <select
              value={filters.minTier || ''}
              onChange={e =>
                updateFilters({ minTier: e.target.value ? (e.target.value as DriverTier) : undefined })
              }
              className="px-3 py-2 rounded bg-surface border border-white/10 hover:border-white/20"
            >
              {tierOptions.map(opt => (
                <option key={opt.label} value={opt.value || ''}>
                  {opt.label}
                </option>
              ))}
            </select>
          </div>

          {/* Risk Flags */}
          <div>
            <p className="text-xs uppercase tracking-widest text-cloud/40 mb-2 font-semibold">
              Hide Risk Flags
            </p>
            <div className="space-y-2">
              <label className="flex items-center gap-2 text-sm text-cloud/70">
                <input
                  type="checkbox"
                  checked={filters.hideFragility}
                  onChange={e => updateFilters({ hideFragility: e.target.checked })}
                  className="rounded"
                />
                Fragility / Key Numbers
              </label>
              <label className="flex items-center gap-2 text-sm text-cloud/70">
                <input
                  type="checkbox"
                  checked={filters.hideBlowout}
                  onChange={e => updateFilters({ hideBlowout: e.target.checked })}
                  className="rounded"
                />
                Blowout Risk
              </label>
              <label className="flex items-center gap-2 text-sm text-cloud/70">
                <input
                  type="checkbox"
                  checked={filters.hideLowCoverage}
                  onChange={e => updateFilters({ hideLowCoverage: e.target.checked })}
                  className="rounded"
                />
                Low Coverage
              </label>
              <label className="flex items-center gap-2 text-sm text-cloud/70">
                <input
                  type="checkbox"
                  checked={filters.hideStaleOdds}
                  onChange={e => updateFilters({ hideStaleOdds: e.target.checked })}
                  className="rounded"
                />
                Stale Odds (5+ min)
              </label>
            </div>
          </div>

          {/* Sort */}
          <div>
            <p className="text-xs uppercase tracking-widest text-cloud/40 mb-2 font-semibold">
              Sort By
            </p>
            <select
              value={filters.sortMode}
              onChange={e => updateFilters({ sortMode: e.target.value as SortMode })}
              className="px-3 py-2 rounded bg-surface border border-white/10 hover:border-white/20"
            >
              {sortOptions.map(opt => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
          </div>

          {/* Search */}
          <div>
            <p className="text-xs uppercase tracking-widest text-cloud/40 mb-2 font-semibold">
              Search Teams
            </p>
            <input
              type="text"
              value={filters.searchQuery}
              onChange={e => updateFilters({ searchQuery: e.target.value })}
              placeholder="Search by team name..."
              className="w-full px-3 py-2 rounded bg-surface border border-white/10 hover:border-white/20 focus:border-white/40 focus:outline-none"
            />
          </div>
        </div>
      )}
    </div>
  );
}
