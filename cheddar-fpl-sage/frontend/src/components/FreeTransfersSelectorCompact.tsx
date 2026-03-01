/**
 * FREE TRANSFERS SELECTOR — Interactive Form Control
 * 
 * Number selector for available free transfers
 */

interface FreeTransfersSelectorProps {
  value: number;
  onChange: (count: number) => void;
}

export default function FreeTransfersSelector({ value, onChange }: FreeTransfersSelectorProps) {
  const options = [0, 1, 2, 3, 4, 5];

  return (
    <div className="flex gap-1.5">
      {options.map((n) => (
        <button
          key={n}
          onClick={() => onChange(n)}
          className={`flex-1 py-2 px-3 rounded-lg text-sm font-bold transition-all border ${
            value === n
              ? 'bg-execute/20 border-execute text-sage-white'
              : 'bg-surface-elevated border-surface-elevated text-sage-muted hover:text-sage-light'
          }`}
        >
          {n}
        </button>
      ))}
    </div>
  );
}
