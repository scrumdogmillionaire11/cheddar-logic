"use client";

interface LoadingStateProps {
  phase?: string;
  progress?: number;
}

export default function LoadingState({ phase, progress }: LoadingStateProps) {
  const phases = [
    { key: "initializing", label: "Initializing analysis" },
    { key: "data_collection", label: "Collecting FPL data" },
    { key: "injury_analysis", label: "Analyzing injuries" },
    { key: "transfer_optimization", label: "Optimizing transfers" },
    { key: "chip_strategy", label: "Evaluating chip strategy" },
    { key: "captain_analysis", label: "Scoring captaincy" },
    { key: "finalization", label: "Finalizing results" },
  ];

  const currentPhaseIndex = phases.findIndex(p => p.key === phase);
  const progressPercent = progress ? Math.round(progress * 100) : 0;

  return (
    <div className="min-h-[400px] rounded-xl border border-white/10 bg-surface/80 p-8">
      <div className="mx-auto max-w-lg space-y-8">
        {/* Animated spinner */}
        <div className="flex justify-center">
          <div className="h-16 w-16 animate-spin rounded-full border-4 border-white/10 border-t-teal"></div>
        </div>

        {/* Status */}
        <div className="text-center">
          <h2 className="mb-2 text-2xl font-semibold">Analyzing Your Team</h2>
          <p className="text-sm text-cloud/60">
            This usually takes 30-60 seconds...
          </p>
        </div>

        {/* Progress bar */}
        {progressPercent > 0 && (
          <div className="space-y-2">
            <div className="h-2 overflow-hidden rounded-full bg-white/10">
              <div
                className="h-full bg-teal transition-all duration-300"
                style={{ width: `${progressPercent}%` }}
              ></div>
            </div>
            <div className="text-center text-sm text-cloud/60">
              {progressPercent}% complete
            </div>
          </div>
        )}

        {/* Phase indicators */}
        {phase && (
          <div className="space-y-2">
            {phases.map((p, idx) => {
              const isActive = p.key === phase;
              const isComplete = currentPhaseIndex > idx;

              return (
                <div
                  key={p.key}
                  className={`flex items-center gap-3 text-sm transition-all ${
                    isActive
                      ? "font-semibold text-teal"
                      : isComplete
                        ? "text-cloud/60"
                        : "text-cloud/30"
                  }`}
                >
                  <div
                    className={`h-2 w-2 rounded-full ${
                      isActive
                        ? "bg-teal"
                        : isComplete
                          ? "bg-cloud/60"
                          : "bg-cloud/20"
                    }`}
                  ></div>
                  {p.label}
                  {isActive && (
                    <span className="ml-auto text-xs text-teal">
                      In progress...
                    </span>
                  )}
                  {isComplete && (
                    <span className="ml-auto text-xs text-cloud/40">✓</span>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

interface ErrorStateProps {
  error: string;
  onRetry?: () => void;
}

export function ErrorState({ error, onRetry }: ErrorStateProps) {
  return (
    <div className="min-h-[400px] rounded-xl border border-red-500/30 bg-red-500/5 p-8">
      <div className="mx-auto max-w-lg space-y-6 text-center">
        <div className="text-6xl">❌</div>
        <div>
          <h2 className="mb-2 text-2xl font-semibold">Analysis Failed</h2>
          <p className="text-sm text-cloud/70">{error}</p>
        </div>
        {onRetry && (
          <button
            onClick={onRetry}
            className="rounded-lg bg-teal px-6 py-3 font-semibold text-night transition hover:opacity-90"
          >
            Try Again
          </button>
        )}
      </div>
    </div>
  );
}
