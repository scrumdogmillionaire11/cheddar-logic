/**
 * RISK POSTURE SELECTOR — Interactive Form Control
 * 
 * Radio group for selecting analysis risk posture
 */

export type RiskPosture = 'conservative' | 'balanced' | 'aggressive';

interface RiskPostureSelectorProps {
  value: RiskPosture;
  onChange: (posture: RiskPosture) => void;
}

const POSTURE_CONFIG = {
  conservative: {
    label: 'Conservative',
    colorClass: 'text-execute border-execute bg-execute/10',
    icon: '🛡️',
    tagline: 'Protect your rank',
  },
  balanced: {
    label: 'Balanced',
    colorClass: 'text-hold border-hold bg-hold/10',
    icon: '⚖️',
    tagline: 'Optimal EV',
  },
  aggressive: {
    label: 'Aggressive',
    colorClass: 'text-risky border-risky bg-risky/10',
    icon: '⚡',
    tagline: 'Chase the ceiling',
  },
};

export default function RiskPostureSelector({ value, onChange }: RiskPostureSelectorProps) {
  return (
    <div className="space-y-2">
      {Object.entries(POSTURE_CONFIG).map(([key, cfg]) => {
        const isActive = value === key;

        return (
          <button
            key={key}
            onClick={() => onChange(key as RiskPosture)}
            className={`w-full flex items-center gap-3 p-3 rounded-lg transition-all text-left border ${
              isActive
                ? cfg.colorClass
                : 'bg-surface-elevated border-surface-elevated'
            }`}
          >
            <div
              className={`w-5 h-5 rounded-full border-2 flex items-center justify-center shrink-0 ${
                isActive
                  ? cfg.colorClass.split(' ')[0].replace('text-', 'border-') + ' ' + cfg.colorClass.split(' ')[0].replace('text-', 'bg-')
                  : 'border-sage-muted bg-transparent'
              }`}
            >
              {isActive && <div className="w-2 h-2 rounded-full bg-surface-primary" />}
            </div>
            <span className="text-base">{cfg.icon}</span>
            <div className="flex-1">
              <div className={`text-sm font-semibold ${
                isActive ? cfg.colorClass.split(' ')[0] : 'text-sage-muted'
              }`}>
                {cfg.label}
              </div>
              <div className="text-xs text-sage-muted">{cfg.tagline}</div>
            </div>
          </button>
        );
      })}
    </div>
  );
}
