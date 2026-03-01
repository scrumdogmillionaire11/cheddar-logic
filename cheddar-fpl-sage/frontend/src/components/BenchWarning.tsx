/**
 * BENCH WARNING — Shows alert when transfers land players on bench
 * 
 * Optimization: Helps users balance immediate needs vs 3-5 week planning
 */

interface BenchWarningProps {
  benchCount: number;
  benchPlayers: string[];
  avgExpectedPts: number;
  warningMessage: string;
  suggestion: string;
  prioritySignal?: string;
  hasUrgent?: boolean;
}

export default function BenchWarning({
  benchCount,
  benchPlayers,
  avgExpectedPts,
  warningMessage,
  suggestion,
  prioritySignal,
  hasUrgent
}: BenchWarningProps) {
  return (
    <div className="flex items-start gap-3 px-4 py-3 bg-hold/10 border border-hold/40 rounded">
      <span className="text-hold text-xl mt-0.5">⏳</span>
      <div className="flex-1 space-y-2">
        <div className="flex items-baseline justify-between">
          <span className="text-body-sm text-sage-white font-medium">
            {hasUrgent ? "⚠️ Urgent + Bench Transfers" : "Bench-Heavy Transfer Strategy"}
          </span>
          <div className="text-right">
            <span className="block text-meta text-sage-muted">
              {benchCount} transfer{benchCount !== 1 ? 's' : ''} on bench
            </span>
            <span className="block text-[11px] text-sage-muted">
              {avgExpectedPts.toFixed(1)} avg xPts
            </span>
          </div>
        </div>
        
        <p className="text-body-sm text-sage-light leading-relaxed">
          {warningMessage}
        </p>
        
        {benchPlayers.length > 0 && (
          <div className="flex flex-wrap gap-2 pt-1">
            {benchPlayers.map((player, idx) => (
              <span
                key={idx}
                className="px-2 py-0.5 text-xs bg-surface-elevated text-sage-muted rounded"
              >
                {player}
              </span>
            ))}
          </div>
        )}
        
        {prioritySignal && (
          <div className="pt-1">
            <span className="text-xs text-hold font-medium">
              📌 {prioritySignal}
            </span>
          </div>
        )}
        
        <div className="pt-2 mt-2 border-t border-surface-elevated">
          <p className="text-body-sm text-sage-muted italic flex items-start gap-2">
            <span>💡</span>
            <span>{suggestion}</span>
          </p>
        </div>
        
        <details className="mt-2">
          <summary className="text-xs text-sage-muted cursor-pointer hover:text-sage-light">
            Why this matters
          </summary>
          <div className="mt-2 pl-4 text-xs text-sage-muted space-y-1">
            <p>
              Multiple bench transfers may not deliver immediate gameweek impact.
            </p>
            <p>
              <strong className="text-sage-light">Measured approach:</strong> Take 1-2 highest priority transfers this week. Roll the rest for Starting XI improvements.
            </p>
            <p>
              <strong className="text-sage-light">Exception:</strong> Building bench depth for Bench Boost chip window (check Chip Strategy section).
            </p>
          </div>
        </details>
      </div>
    </div>
  );
}
