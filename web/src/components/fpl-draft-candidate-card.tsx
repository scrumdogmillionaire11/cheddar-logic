import type { DraftCandidate } from '@/lib/fpl-api';

interface FPLDraftCandidateCardProps {
  candidate: DraftCandidate;
  isLocked?: boolean;
  isBanned?: boolean;
  onLock?: () => void;
  onBan?: () => void;
  onRemove?: () => void;
}

const POSITION_COLORS: Record<string, string> = {
  GK: 'bg-yellow-500/20 text-yellow-300',
  DEF: 'bg-blue-500/20 text-blue-300',
  MID: 'bg-green-500/20 text-green-300',
  FWD: 'bg-red-500/20 text-red-300',
};

export default function FPLDraftCandidateCard({
  candidate,
  isLocked = false,
  isBanned = false,
  onLock,
  onBan,
  onRemove,
}: FPLDraftCandidateCardProps) {
  return (
    <div
      className={`rounded-lg border px-4 py-3 flex items-center justify-between gap-3 ${
        isBanned
          ? 'border-red-500/30 bg-red-500/5 opacity-60'
          : isLocked
          ? 'border-teal/30 bg-teal/5'
          : 'border-cloud/10 bg-surface/50'
      }`}
    >
      <div className="flex items-center gap-3 min-w-0">
        <span
          className={`shrink-0 rounded px-1.5 py-0.5 text-xs font-semibold ${
            POSITION_COLORS[candidate.position] ?? 'bg-cloud/10 text-cloud/70'
          }`}
        >
          {candidate.position}
        </span>
        <div className="min-w-0">
          <p className="text-sm font-medium text-cloud truncate">{candidate.name}</p>
          <p className="text-xs text-cloud/50">{candidate.team} · £{candidate.price.toFixed(1)}m</p>
        </div>
        <div className="flex gap-1.5 shrink-0">
          {isLocked && (
            <span className="rounded bg-teal/20 px-1.5 py-0.5 text-xs font-semibold text-teal">
              Locked
            </span>
          )}
          {isBanned && (
            <span className="rounded bg-red-500/20 px-1.5 py-0.5 text-xs font-semibold text-red-400">
              Banned
            </span>
          )}
        </div>
      </div>

      <div className="flex items-center gap-1 shrink-0">
        {onLock && (
          <button
            onClick={onLock}
            title={isLocked ? 'Unlock' : 'Lock'}
            className={`rounded p-1.5 text-xs transition-colors ${
              isLocked
                ? 'bg-teal/20 text-teal hover:bg-teal/30'
                : 'text-cloud/40 hover:text-teal hover:bg-teal/10'
            }`}
          >
            {isLocked ? '🔒' : '🔓'}
          </button>
        )}
        {onBan && (
          <button
            onClick={onBan}
            title={isBanned ? 'Unban' : 'Ban'}
            className={`rounded p-1.5 text-xs transition-colors ${
              isBanned
                ? 'bg-red-500/20 text-red-400 hover:bg-red-500/30'
                : 'text-cloud/40 hover:text-red-400 hover:bg-red-500/10'
            }`}
          >
            ✕
          </button>
        )}
        {onRemove && (
          <button
            onClick={onRemove}
            title="Remove"
            className="rounded p-1.5 text-xs text-cloud/30 hover:text-cloud/60 hover:bg-cloud/10 transition-colors"
          >
            Remove
          </button>
        )}
      </div>
    </div>
  );
}
