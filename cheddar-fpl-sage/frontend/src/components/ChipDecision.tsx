/**
 * CHIP DECISION — Always Visible
 *
 * Shows chip verdict with explicit FIRE / WATCH / PASS states.
 */

import { CHIP_DESCRIPTIONS } from '@/lib/actionDescriptions';
import { useMemo, useState } from 'react';

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

const resolveChipStatus = (explanation: string, chipVerdict: string): 'FIRE' | 'WATCH' | 'PASS' => {
  const head = String(explanation || '').trim().toUpperCase();
  if (head.startsWith('FIRE:')) return 'FIRE';
  if (head.startsWith('WATCH:')) return 'WATCH';
  if (head.startsWith('PASS:')) return 'PASS';
  return chipVerdict !== 'NONE' ? 'FIRE' : 'PASS';
};

const cleanExplanation = (explanation: string): string =>
  String(explanation || '')
    .replace(/^(FIRE|WATCH|PASS):\s*/i, '')
    .trim();

export default function ChipDecision({
  chipVerdict,
  explanation,
  availableChips,
  opportunityCost,
  bestGw,
  bestFutureWindowName,
}: ChipDecisionProps) {
  const [showFutureWindows, setShowFutureWindows] = useState(false);

  const chipStatus = useMemo(() => resolveChipStatus(explanation, chipVerdict), [explanation, chipVerdict]);

  const chipMap: Record<string, keyof typeof CHIP_DESCRIPTIONS> = {
    BB: 'bench_boost',
    FH: 'free_hit',
    WC: 'wildcard',
    TC: 'triple_captain',
    NONE: 'NONE',
  };

  const chipKey = chipMap[chipVerdict] || 'NONE';
  const chipDesc = CHIP_DESCRIPTIONS[chipKey];

  const chipColor = chipVerdict === 'NONE' ? 'text-sage-muted' : chipStatus === 'FIRE' ? 'text-execute' : 'text-sage-light';

  const isFire = chipStatus === 'FIRE';
  const isWatch = chipStatus === 'WATCH';

  return (
    <section className="bg-surface-card border border-surface-elevated p-8">
      <h2 className="text-section text-sage-muted mb-6 uppercase tracking-wider">Chip Strategy</h2>

      <div className="space-y-4">
        <div className="space-y-3">
          {isFire && (
            <div className="flex items-center gap-2 px-3 py-2 bg-execute/10 border border-execute/30 rounded mb-2">
              <span className="text-execute">🎯</span>
              <span className="text-body-sm text-sage-white font-medium">Optimal window - use this GW</span>
            </div>
          )}

          {isWatch && (
            <div className="flex items-center gap-2 px-3 py-2 bg-surface-elevated border border-sage-muted/30 rounded mb-2">
              <span>👀</span>
              <span className="text-body-sm text-sage-white font-medium">WATCH - hold for a better upcoming window</span>
            </div>
          )}

          {!isFire && !isWatch && (
            <div className="flex items-center gap-2 px-3 py-2 bg-surface-elevated border border-surface-elevated rounded mb-2">
              <span>⏸️</span>
              <span className="text-body-sm text-sage-light font-medium">PASS - no chip activation this GW</span>
            </div>
          )}

          <div className="flex items-baseline gap-3">
            <span className="text-3xl">{chipDesc.emoji}</span>
            <div className={`text-decision font-semibold ${chipColor}`}>{chipDesc.name}</div>
          </div>
          <p className="text-body-sm text-sage-muted italic">{chipDesc.long}</p>
          <p className="text-body text-sage-light max-w-xl pt-2">{cleanExplanation(explanation)}</p>
        </div>

        {isWatch && opportunityCost && bestGw && (
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
                <span className="text-body text-execute font-medium">+{opportunityCost.delta.toFixed(1)} pts</span>
                <span className="text-body-sm text-sage-muted">
                  ({opportunityCost.best_value.toFixed(1)}pts in GW{bestGw} vs {opportunityCost.current_value.toFixed(1)}pts this week)
                </span>
              </div>
            </div>
          </div>
        )}

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
