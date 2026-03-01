/**
 * CHIP DECISION — Always Visible
 * 
 * Shows chip verdict even if NONE (with reason)
 */

import { CHIP_DESCRIPTIONS } from '@/lib/actionDescriptions';
import { useState } from 'react';

interface OpportunityCost {
  current_value: number;
  best_value: number;
  best_gw?: number;
  delta: number;
}

interface ChipDecisionProps {
  chipVerdict: 'NONE' | 'BB' | 'FH' | 'WC' | 'TC';
  explanation: string;
  availableChips?: string[];
  opportunityCost?: OpportunityCost | null;
  bestGw?: number;
  currentWindowName?: string;
  bestFutureWindowName?: string;
}

export default function ChipDecision({
  chipVerdict,
  explanation,
  availableChips,
  opportunityCost,
  bestGw,
  bestFutureWindowName
}: ChipDecisionProps) {
  const [showFutureWindows, setShowFutureWindows] = useState(false);

  const getChipColor = () => {
    if (chipVerdict === 'NONE') return 'text-sage-muted';
    return 'text-execute';
  };

  // Map chip codes to full descriptions
  const chipMap: Record<string, keyof typeof CHIP_DESCRIPTIONS> = {
    'BB': 'bench_boost',
    'FH': 'free_hit',
    'WC': 'wildcard',
    'TC': 'triple_captain',
    'NONE': 'NONE'
  };

  const chipKey = chipMap[chipVerdict] || 'NONE';
  const chipDesc = CHIP_DESCRIPTIONS[chipKey];

  // Determine if this is an ACTIVE recommendation (use now) or SAVE
  const isActiveRecommendation = chipVerdict !== 'NONE';

  return (
    <section className="bg-surface-card border border-surface-elevated p-8">
      <h2 className="text-section text-sage-muted mb-6 uppercase tracking-wider">Chip Strategy</h2>

      <div className="space-y-4">
        <div className="space-y-3">
          {/* Urgency indicator for ACTIVE chips */}
          {isActiveRecommendation && (
            <div className="flex items-center gap-2 px-3 py-2 bg-execute/10 border border-execute/30 rounded mb-2">
              <span className="text-execute">🎯</span>
              <span className="text-body-sm text-sage-white font-medium">
                Optimal window - use this GW
              </span>
            </div>
          )}

          <div className="flex items-baseline gap-3">
            <span className="text-3xl">{chipDesc.emoji}</span>
            <div className={`text-decision font-semibold ${getChipColor()}`}>
              {chipDesc.name}
            </div>
          </div>
          <p className="text-body-sm text-sage-muted italic">
            {chipDesc.long}
          </p>
          <p className="text-body text-sage-light max-w-xl pt-2">
            {explanation}
          </p>
        </div>

        {/* Timing Analysis Section - for SAVE recommendations with opportunity cost */}
        {!isActiveRecommendation && opportunityCost && bestGw && (
          <div className="pt-4 border-t border-surface-elevated space-y-3">
            <div className="text-body-sm text-sage-muted uppercase tracking-wider">Timing Analysis</div>
            <div className="space-y-2">
              <div className="flex items-baseline gap-2">
                <span className="text-body text-sage-light">Best upcoming window:</span>
                <span className="text-body text-sage-white font-medium">
                  GW{bestGw} {bestFutureWindowName ? `(${bestFutureWindowName})` : ''}
                </span>
              </div>
              <div className="flex items-baseline gap-2">
                <span className="text-body text-sage-light">Expected value gain:</span>
                <span className="text-body text-execute font-medium">
                  +{opportunityCost.delta.toFixed(1)} pts
                </span>
                <span className="text-body-sm text-sage-muted">
                  ({opportunityCost.best_value.toFixed(1)}pts in GW{bestGw} vs {opportunityCost.current_value.toFixed(1)}pts this week)
                </span>
              </div>
            </div>
          </div>
        )}

        {/* Future chip windows - expandable */}
        {availableChips && availableChips.length > 1 && (
          <div className="pt-4 border-t border-surface-elevated">
            <button
              onClick={() => setShowFutureWindows(!showFutureWindows)}
              className="flex items-center gap-2 text-body-sm text-sage-muted hover:text-sage-light transition-colors"
            >
              <span>{showFutureWindows ? '▼' : '▶'}</span>
              <span>See future chip windows</span>
            </button>
            {showFutureWindows && (
              <div className="mt-3 pl-6 text-body-sm text-sage-light">
                <p>Available chips: {availableChips.join(', ')}</p>
                <p className="text-sage-muted mt-1">
                  Plan ahead for optimal chip timing based on fixtures and squad composition.
                </p>
              </div>
            )}
          </div>
        )}

        {availableChips && availableChips.length > 0 && !showFutureWindows && (
          <div className="text-body-sm text-sage-muted pt-4 border-t border-surface-elevated">
            Available: {availableChips.join(' · ')}
          </div>
        )}
      </div>
    </section>
  );
}
