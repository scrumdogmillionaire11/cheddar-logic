/**
 * TRANSFER SECTION — Always Visible
 *
 * Shows transfer recommendation or roll explanation inline
 */

import BenchWarning from './BenchWarning';

interface TransferAlternative {
  name: string;
  price: number;
  points: number;
  strategy: 'VALUE' | 'PREMIUM' | 'BALANCED';
}

interface Transfer {
  out: string;
  in: string;
  hitCost: number;
  netCost: number;
  deltaPoints4GW?: number;
  deltaPoints6GW?: number;
  reason: string;
  confidence?: string;
  confidence_context?: string;
  urgency?: string;
  is_marginal?: boolean;
  alternatives?: TransferAlternative[];
}

interface BenchWarningData {
  bench_count: number;
  bench_players: string[];
  avg_expected_pts: number;
  warning_message: string;
  suggestion: string;
  priority_signal?: string;
  has_urgent?: boolean;
}

interface TransferSectionProps {
  primaryPlan?: Transfer;
  secondaryPlan?: Transfer;
  additionalPlans?: Transfer[];
  noTransferReason?: string;
  freeTransfers?: number;
  benchWarning?: BenchWarningData;
}

export default function TransferSection({
  primaryPlan,
  secondaryPlan,
  additionalPlans,
  noTransferReason,
  freeTransfers,
  benchWarning
}: TransferSectionProps) {

  // If no transfer recommended - show roll explanation
  if (!primaryPlan && noTransferReason) {
    return (
      <section className="bg-surface-card border border-surface-elevated p-8">
        <div className="flex items-baseline justify-between mb-4">
          <h2 className="text-section text-sage-muted uppercase tracking-wider">Transfers</h2>
          {freeTransfers !== undefined && (
            <div className="text-meta text-sage-muted">
              {freeTransfers} free transfer{freeTransfers !== 1 ? 's' : ''} available
            </div>
          )}
        </div>
        <div className="flex items-baseline gap-3 mb-3">
          <span className="text-2xl">💰</span>
          <div className="text-h3 text-sage-light font-medium">ROLL TRANSFER</div>
        </div>
        <p className="text-body-sm text-sage-muted italic mb-2">
          Save your free transfer(s) to have more options next gameweek
        </p>
        <p className="text-body text-sage-light leading-relaxed max-w-xl">
          {noTransferReason}
        </p>
        <div className="mt-4 pt-4 border-t border-surface-elevated">
          <p className="text-body-sm text-sage-muted">
            💡 Banking transfer gives {freeTransfers === 1 ? '2FT' : 'extra'} flexibility next week
          </p>
        </div>
      </section>
    );
  }

  // If no transfer data at all
  if (!primaryPlan) {
    return (
      <section className="bg-surface-card border border-surface-elevated p-8">
        <h2 className="text-section text-sage-muted mb-4 uppercase tracking-wider">Transfers</h2>
        <div className="text-h3 text-sage-light font-medium mb-3">NONE</div>
        <p className="text-body text-sage-light leading-relaxed max-w-xl">
          No transfer clears value thresholds this GW.
        </p>
      </section>
    );
  }

  // Show transfer recommendation inline
  return (
    <section className="bg-surface-card border border-surface-elevated p-8">
      {/* Header */}
      <div className="flex items-baseline justify-between mb-6">
        <h2 className="text-section text-sage-muted uppercase tracking-wider">Transfers</h2>
        {freeTransfers !== undefined && (
          <span className="text-meta text-sage-muted">
            {freeTransfers} free transfer{freeTransfers !== 1 ? 's' : ''}
          </span>
        )}
      </div>

      {/* Primary Transfer */}
      <div className="space-y-4">
        {/* Urgency indicators ABOVE transfer arrow */}
        {primaryPlan.urgency === 'injury' && (
          <div className="flex items-center gap-2 px-3 py-2 bg-veto/10 border border-veto/30 rounded">
            <span className="text-veto">⚠️</span>
            <span className="text-body-sm text-sage-white font-medium">Injury/suspension - act before deadline</span>
          </div>
        )}
        {primaryPlan.urgency === 'urgent' && !primaryPlan.urgency.includes('injury') && (
          <div className="flex items-center gap-2 px-3 py-2 bg-execute/10 border border-execute/30 rounded">
            <span className="text-execute">🚨</span>
            <span className="text-body-sm text-sage-white font-medium">Urgent transfer recommended</span>
          </div>
        )}
        {primaryPlan.is_marginal && !primaryPlan.urgency && (
          <div className="flex items-center gap-2 px-3 py-2 bg-hold/10 border border-hold/30 rounded">
            <span className="text-hold">💰</span>
            <span className="text-body-sm text-sage-white">
              Marginal gain ({primaryPlan.deltaPoints4GW?.toFixed(1)}pts over 4GW) - consider rolling transfer
            </span>
          </div>
        )}

        {/* Transfer arrow - the main visual */}
        <div className="flex items-center gap-4">
          <div className="flex flex-col items-end">
            <span className="text-xs text-sage-muted uppercase tracking-wide mb-1">OUT</span>
            <span className="text-h3 text-veto font-medium">{primaryPlan.out}</span>
          </div>
          <span className="text-h4 text-sage-muted mt-6">→</span>
          <div className="flex flex-col items-start">
            <span className="text-xs text-sage-muted uppercase tracking-wide mb-1">IN</span>
            <span className="text-h3 text-execute font-medium">{primaryPlan.in}</span>
          </div>
        </div>

        {/* Bench Warning - positioned below transfer arrow, before metrics */}
        {benchWarning && (
          <BenchWarning
            benchCount={benchWarning.bench_count}
            benchPlayers={benchWarning.bench_players}
            avgExpectedPts={benchWarning.avg_expected_pts}
            warningMessage={benchWarning.warning_message}
            suggestion={benchWarning.suggestion}
          />
        )}

        {/* Metrics row */}
        <div className="flex flex-wrap gap-6 text-body">
          <div>
            <span className="text-sage-muted">Hit: </span>
            <span className={primaryPlan.hitCost > 0 ? 'text-veto font-medium' : 'text-execute font-medium'}>
              {primaryPlan.hitCost > 0 ? `-${primaryPlan.hitCost}pts` : 'Free'}
            </span>
          </div>
          <div>
            <span className="text-sage-muted">Net £: </span>
            <span className="text-sage-white font-medium">
              {primaryPlan.netCost > 0 ? `+${primaryPlan.netCost}m` : primaryPlan.netCost < 0 ? `${primaryPlan.netCost}m` : '0m'}
            </span>
          </div>
          {primaryPlan.deltaPoints4GW !== undefined && primaryPlan.deltaPoints4GW !== null && (
            <div>
              <span className="text-sage-muted">Δ 4GW: </span>
              <span className={primaryPlan.deltaPoints4GW > 0 ? 'text-execute font-medium' : 'text-sage-white font-medium'}>
                {primaryPlan.deltaPoints4GW > 0 ? '+' : ''}{primaryPlan.deltaPoints4GW.toFixed(1)} pts
              </span>
            </div>
          )}
        </div>

        {/* Confidence badge */}
        {primaryPlan.confidence && (
          <div className="flex items-center gap-2">
            {primaryPlan.confidence === 'HIGH' && (
              <span className="inline-flex items-center gap-1.5 px-2.5 py-1 bg-execute/20 border border-execute/40 rounded text-body-sm text-execute">
                ✓ High confidence
              </span>
            )}
            {primaryPlan.confidence === 'MEDIUM' && (
              <span className="inline-flex items-center gap-1.5 px-2.5 py-1 bg-hold/20 border border-hold/40 rounded text-body-sm text-hold">
                ⚡ Moderate confidence
              </span>
            )}
            {primaryPlan.confidence === 'LOW' && (
              <span className="inline-flex items-center gap-1.5 px-2.5 py-1 bg-veto/20 border border-veto/40 rounded text-body-sm text-veto">
                ⚠️ Speculative
              </span>
            )}
            {primaryPlan.confidence_context && (
              <span className="text-body-sm text-sage-muted">· {primaryPlan.confidence_context}</span>
            )}
          </div>
        )}

        {/* Reason */}
        {primaryPlan.reason && (
          <p className="text-body text-sage-light leading-relaxed max-w-xl pt-2 border-t border-surface-elevated">
            {primaryPlan.reason}
          </p>
        )}

        {/* Strategic Alternatives */}
        {primaryPlan.alternatives && primaryPlan.alternatives.length > 0 && (
          <div className="mt-4 pt-4 border-t border-surface-elevated">
            <div className="text-body-sm text-sage-muted uppercase tracking-wider mb-3">Alternative Options</div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {primaryPlan.alternatives.map((alt, idx) => (
                <div key={idx} className="flex items-center gap-3 p-3 bg-surface-base rounded border border-surface-elevated">
                  <div className="flex-1">
                    <div className="flex items-center gap-2">
                      <span className="text-body font-medium text-sage-white">{alt.name}</span>
                      {alt.strategy === 'VALUE' && (
                        <span className="inline-flex items-center px-2 py-0.5 bg-execute/20 border border-execute/40 rounded text-xs text-execute">
                          VALUE
                        </span>
                      )}
                      {alt.strategy === 'PREMIUM' && (
                        <span className="inline-flex items-center px-2 py-0.5 bg-hold/20 border border-hold/40 rounded text-xs text-hold">
                          PREMIUM
                        </span>
                      )}
                      {alt.strategy === 'BALANCED' && (
                        <span className="inline-flex items-center px-2 py-0.5 bg-sage-muted/20 border border-sage-muted/40 rounded text-xs text-sage-muted">
                          BALANCED
                        </span>
                      )}
                    </div>
                    <div className="text-body-sm text-sage-muted mt-1">
                      £{alt.price.toFixed(1)}m · {alt.points.toFixed(1)} pts
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Secondary Plan (if exists) */}
      {secondaryPlan && (
        <div className="mt-6 pt-6 border-t border-surface-elevated">
          <div className="text-body-sm text-sage-muted uppercase tracking-wider mb-4">Backup Option</div>
          <div className="space-y-3">
            <div className="flex items-center gap-3 text-body">
              <span className="text-veto">{secondaryPlan.out}</span>
              <span className="text-sage-muted">→</span>
              <span className="text-hold">{secondaryPlan.in}</span>
            </div>
            <div className="flex gap-4 text-body-sm text-sage-muted">
              <span>Hit: {secondaryPlan.hitCost > 0 ? `-${secondaryPlan.hitCost}pts` : 'Free'}</span>
              <span>Net £: {secondaryPlan.netCost > 0 ? `+${secondaryPlan.netCost}m` : `${secondaryPlan.netCost}m`}</span>
            </div>
            {secondaryPlan.reason && (
              <p className="text-body-sm text-sage-muted">
                {secondaryPlan.reason}
              </p>
            )}
          </div>
        </div>
      )}

      {/* Additional Transfers (for users with 3+ free transfers) */}
      {additionalPlans && additionalPlans.length > 0 && (
        <div className="mt-6 pt-6 border-t border-surface-elevated">
          <div className="text-body-sm text-sage-muted uppercase tracking-wider mb-4">
            Additional Options ({additionalPlans.length})
          </div>
          <div className="space-y-4">
            {additionalPlans.map((plan, index) => (
              <div key={index} className="space-y-2">
                <div className="flex items-center gap-3 text-body">
                  <span className="text-veto">{plan.out}</span>
                  <span className="text-sage-muted">→</span>
                  <span className="text-hold">{plan.in}</span>
                </div>
                <div className="flex gap-4 text-body-sm text-sage-muted">
                  <span>Hit: {plan.hitCost > 0 ? `-${plan.hitCost}pts` : 'Free'}</span>
                  <span>Net £: {plan.netCost > 0 ? `+${plan.netCost}m` : `${plan.netCost}m`}</span>
                  {plan.deltaPoints4GW !== undefined && plan.deltaPoints4GW !== null && (
                    <span>Δ 4GW: {plan.deltaPoints4GW > 0 ? '+' : ''}{plan.deltaPoints4GW.toFixed(1)} pts</span>
                  )}
                </div>
                {plan.reason && (
                  <p className="text-body-sm text-sage-muted">{plan.reason}</p>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}
