/**
 * INJURY OVERRIDE SELECTOR — Interactive Form Control
 * 
 * Dynamic list for player injury status overrides
 */

import { type InjuryOverride } from '@/lib/api';

interface InjuryOverrideSelectorProps {
  value: InjuryOverride[];
  onChange: (overrides: InjuryOverride[]) => void;
}

const STATUS_CONFIG = {
  FIT: { colorClass: 'border-execute text-execute', bgClass: 'bg-execute/5' },
  DOUBTFUL: { colorClass: 'border-risky text-risky', bgClass: 'bg-risky/5' },
  OUT: { colorClass: 'border-veto text-veto', bgClass: 'bg-veto/5' },
};

export default function InjuryOverrideSelector({ value, onChange }: InjuryOverrideSelectorProps) {
  const update = (i: number, field: keyof InjuryOverride, val: string | number) => {
    onChange(value.map((inj, idx) => (idx === i ? { ...inj, [field]: val } : inj)));
  };

  const add = () => {
    onChange([...value, { player_name: '', status: 'DOUBTFUL', chance: 75 }]);
  };

  const remove = (i: number) => {
    onChange(value.filter((_, idx) => idx !== i));
  };

  if (value.length === 0) {
    return (
      <button
        onClick={add}
        className="w-full py-2 px-3 rounded-lg text-xs font-semibold border border-dashed border-surface-elevated text-sage-muted hover:text-sage-light hover:border-sage-muted transition-colors text-left"
      >
        + Add player override
      </button>
    );
  }

  return (
    <div className="space-y-2">
      {value.map((inj, i) => {
        const statusCfg = STATUS_CONFIG[inj.status];
        return (
          <div
            key={i}
            className={`grid grid-cols-[2fr_1fr_1fr_auto] gap-2 items-center p-2 rounded-lg border ${statusCfg.bgClass} ${statusCfg.colorClass} border-l-4`}
          >
            <input
              placeholder="Player name"
              value={inj.player_name}
              onChange={(e) => update(i, 'player_name', e.target.value)}
              className="px-2 py-1 rounded text-xs bg-surface-elevated border border-surface-elevated text-sage-white outline-none focus:border-execute"
            />
            <select
              value={inj.status}
              onChange={(e) => update(i, 'status', e.target.value as InjuryOverride['status'])}
              className={`px-2 py-1 rounded text-xs bg-surface-elevated border border-surface-elevated outline-none focus:border-execute ${statusCfg.colorClass.split(' ')[1]}`}
            >
              <option value="FIT">FIT</option>
              <option value="DOUBTFUL">DOUBTFUL</option>
              <option value="OUT">OUT</option>
            </select>
            <div className="relative">
              <input
                type="number"
                value={inj.chance}
                min={0}
                max={100}
                onChange={(e) => update(i, 'chance', +e.target.value)}
                className="w-full px-2 py-1 pr-6 rounded text-xs bg-surface-elevated border border-surface-elevated text-sage-white outline-none focus:border-execute"
              />
              <span className="absolute right-2 top-1/2 -translate-y-1/2 text-[10px] text-sage-muted">
                %
              </span>
            </div>
            <button
              onClick={() => remove(i)}
              className="p-1 rounded bg-veto/10 border border-veto/40 text-veto hover:bg-veto/20 transition-colors text-xs"
            >
              ✕
            </button>
          </div>
        );
      })}
      <button
        onClick={add}
        className="w-full py-1.5 px-3 rounded-lg text-xs font-semibold border border-dashed border-surface-elevated text-sage-muted hover:text-sage-light hover:border-sage-muted transition-colors"
      >
        + Add another
      </button>
    </div>
  );
}
