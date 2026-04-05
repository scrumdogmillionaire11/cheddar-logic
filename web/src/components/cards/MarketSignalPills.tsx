'use client';

import type { MarketSignalPill } from '@/lib/game-card/market-signals';

const COLOR_CLASSES: Record<
  MarketSignalPill['color'],
  { bg: string; text: string; border: string }
> = {
  blue: {
    bg: 'bg-blue-700/40',
    text: 'text-blue-200',
    border: 'border-blue-600/60',
  },
  amber: {
    bg: 'bg-amber-700/40',
    text: 'text-amber-200',
    border: 'border-amber-600/60',
  },
  green: {
    bg: 'bg-green-700/40',
    text: 'text-green-200',
    border: 'border-green-600/60',
  },
  slate: {
    bg: 'bg-slate-700/40',
    text: 'text-slate-200',
    border: 'border-slate-600/60',
  },
  emerald: {
    bg: 'bg-emerald-700/40',
    text: 'text-emerald-200',
    border: 'border-emerald-600/60',
  },
};

interface MarketSignalPillsProps {
  pills: MarketSignalPill[];
}

/**
 * Renders market condition pills (Sharp Divergence, Public Heavy, etc.).
 * Returns null when the pills array is empty — no empty DOM.
 */
export default function MarketSignalPills({ pills }: MarketSignalPillsProps) {
  if (pills.length === 0) return null;

  return (
    <div className="flex flex-wrap gap-1.5 mt-2">
      {pills.map((pill) => {
        const cls = COLOR_CLASSES[pill.color];
        return (
          <span
            key={pill.label}
            className={`px-2 py-0.5 text-xs font-semibold rounded border ${cls.bg} ${cls.text} ${cls.border}`}
          >
            {pill.label}
          </span>
        );
      })}
    </div>
  );
}
