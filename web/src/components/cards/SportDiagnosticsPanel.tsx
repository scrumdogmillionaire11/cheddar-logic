'use client';

import { BUCKET_LABELS } from './CardsPageContext';
import type { DiagnosticBucket, SportDiagnosticsMap } from './types';

export default function SportDiagnosticsPanel({
  diagnostics,
  onBucketClick,
}: {
  diagnostics: SportDiagnosticsMap;
  onBucketClick: (sport: string, bucket: DiagnosticBucket) => void;
}) {
  const sportsWithBlocked = Object.entries(diagnostics).filter(
    ([, buckets]) =>
      buckets.missingMapping +
        buckets.driverLoadFailed +
        buckets.noOdds +
        buckets.noProjection +
        (buckets.projectionOnly ?? 0) >
      0,
  );
  if (sportsWithBlocked.length === 0) return null;
  const totalBlocked = sportsWithBlocked.reduce(
    (sum, [, b]) =>
      sum + b.missingMapping + b.driverLoadFailed + b.noOdds + b.noProjection + (b.projectionOnly ?? 0),
    0,
  );

  return (
    <details className="mb-4 border-t border-white/10 pt-2">
      <summary className="cursor-pointer text-xs text-cloud/50 hover:text-cloud/70 select-none">
        Diagnostics — {totalBlocked} game{totalBlocked !== 1 ? 's' : ''} blocked
      </summary>
      <div className="mt-2 overflow-x-auto">
        <table className="w-full text-xs text-cloud/50">
          <thead>
            <tr>
              <th className="text-left pr-4 pb-1 font-normal">Sport</th>
              <th className="text-center px-2 pb-1 font-normal">No odds</th>
              <th className="text-center px-2 pb-1 font-normal">Missing map</th>
              <th className="text-center px-2 pb-1 font-normal">Driver failed</th>
              <th className="text-center px-2 pb-1 font-normal">Proj only</th>
              <th className="text-center px-2 pb-1 font-normal">No projection</th>
            </tr>
          </thead>
          <tbody>
            {sportsWithBlocked.map(([sport, buckets]) => (
              <tr key={sport}>
                <td className="pr-4 py-0.5 font-mono">{sport}</td>
                {(
                  [
                    'noOdds',
                    'missingMapping',
                    'driverLoadFailed',
                    'projectionOnly',
                    'noProjection',
                  ] as const
                ).map((bucket) => (
                  <td key={bucket} className="text-center px-2 py-0.5">
                    {buckets[bucket] > 0 ? (
                      <button
                        onClick={() => onBucketClick(sport, bucket)}
                        className="underline decoration-dotted hover:text-cloud/80 tabular-nums"
                        title={`Show ${buckets[bucket]} blocked ${sport} — ${BUCKET_LABELS[bucket]}`}
                      >
                        {buckets[bucket]}
                      </button>
                    ) : (
                      <span className="text-cloud/20">—</span>
                    )}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
}
