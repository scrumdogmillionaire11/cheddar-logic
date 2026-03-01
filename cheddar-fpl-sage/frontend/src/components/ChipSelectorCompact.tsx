/**
 * CHIP SELECTOR — Interactive Form Control
 * 
 * Multi-select chip availability for analysis configuration
 */

export type ChipStatus = {
  wildcard: boolean;
  benchBoost: boolean;
  tripleCaptain: boolean;
  freeHit: boolean;
};

interface ChipSelectorProps {
  value: ChipStatus | null;
  onChange: (chips: ChipStatus) => void;
}

const CHIPS = [
  { id: 'wildcard' as const, label: 'Wildcard', icon: '🃏' },
  { id: 'benchBoost' as const, label: 'Bench Boost', icon: '📈' },
  { id: 'tripleCaptain' as const, label: 'Triple Captain', icon: '👑' },
  { id: 'freeHit' as const, label: 'Free Hit', icon: '🎯' },
];

export default function ChipSelector({ value, onChange }: ChipSelectorProps) {
  const chips = value || { wildcard: false, benchBoost: false, tripleCaptain: false, freeHit: false };

  const toggle = (id: keyof ChipStatus) => {
    onChange({ ...chips, [id]: !chips[id] });
  };

  return (
    <div className="grid grid-cols-2 gap-2">
      {CHIPS.map((chip) => {
        const isOn = chips[chip.id];
        return (
          <button
            key={chip.id}
            onClick={() => toggle(chip.id)}
            className={`flex items-center gap-2 p-2.5 rounded-lg transition-all text-left border ${
              isOn
                ? 'bg-execute/10 border-execute/40'
                : 'bg-surface-elevated border-surface-elevated hover:border-surface-elevated'
            }`}
          >
            <div
              className={`w-4 h-4 rounded border-2 flex items-center justify-center shrink-0 ${
                isOn ? 'border-execute bg-execute' : 'border-sage-muted bg-transparent'
              }`}
            >
              {isOn && <span className="text-[9px] font-black text-surface-primary leading-none">✓</span>}
            </div>
            <span className="text-sm">{chip.icon}</span>
            <span className={`text-xs font-semibold ${
              isOn ? 'text-execute' : 'text-sage-muted'
            }`}>
              {chip.label}
            </span>
          </button>
        );
      })}
    </div>
  );
}
