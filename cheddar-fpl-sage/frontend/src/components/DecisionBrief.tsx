/**
 * DECISION SUMMARY — Always Visible
 * 
 * Answers: "What should I do this Gameweek?"
 * No scrolling required.
 */

import { ACTION_DESCRIPTIONS, CONFIDENCE_DESCRIPTIONS } from '@/lib/actionDescriptions';

interface DecisionBriefProps {
  primaryAction: string;
  confidence: 'HIGH' | 'MED' | 'LOW';
  justification: string;
  gameweek?: number;
  /** Backend-derived label: "HIGH" | "MEDIUM" | "LOW" — supersedes local confidence when present */
  confidenceLabel?: string;
  /** One-line backend summary — replaces computed confidenceDesc.long when present */
  confidenceSummary?: string;
}

export default function DecisionBrief({ 
  primaryAction, 
  confidence, 
  justification,
  gameweek,
  confidenceLabel,
  confidenceSummary,
}: DecisionBriefProps) {
  // Normalise backend confidence_label ("MEDIUM" → "MED") for local lookup
  const normaliseLabel = (label?: string): 'HIGH' | 'MED' | 'LOW' => {
    if (!label) return confidence;
    const u = label.toUpperCase();
    if (u === 'HIGH') return 'HIGH';
    if (u === 'LOW') return 'LOW';
    return 'MED';
  };
  const displayConfidence = normaliseLabel(confidenceLabel);

  const getConfidenceColor = () => {
    switch (displayConfidence) {
      case 'HIGH': return 'text-execute';
      case 'MED': return 'text-hold';
      case 'LOW': return 'text-veto';
      default: return 'text-sage-white';
    }
  };

  // Get user-friendly descriptions
  const actionKey = primaryAction.toUpperCase() as keyof typeof ACTION_DESCRIPTIONS;
  const actionDesc = ACTION_DESCRIPTIONS[actionKey];
  const confidenceDesc = CONFIDENCE_DESCRIPTIONS[displayConfidence];

  return (
    <section className="bg-surface-elevated border border-surface-elevated p-8">
      {gameweek && (
        <div className="text-meta text-sage-muted mb-6 uppercase tracking-wider">
          Gameweek {gameweek}
        </div>
      )}
      
      <div className="space-y-6">
        {/* Primary Action - Clean and authoritative with explanation */}
        <div className="space-y-3">
          <div className="flex items-baseline gap-3">
            {actionDesc && <span className="text-3xl">{actionDesc.emoji}</span>}
            <div className="text-page-title text-sage-white font-semibold tracking-tight">
              {actionDesc?.short || primaryAction}
            </div>
          </div>
          {actionDesc && (
            <p className="text-body-sm text-sage-muted italic">
              {actionDesc.long}
            </p>
          )}
          <div className="flex items-baseline gap-2">
            {confidenceDesc && <span className="text-lg">{confidenceDesc.emoji}</span>}
            <div className={`text-section ${getConfidenceColor()} font-medium uppercase tracking-wider`}>
              {confidenceLabel?.toUpperCase() || confidenceDesc?.short || `${displayConfidence} Confidence`}
            </div>
          </div>
          {confidenceDesc && (
            <p className="text-body-sm text-sage-muted italic">
              {confidenceSummary || confidenceDesc.long}
            </p>
          )}
        </div>

        {/* Justification - Subtle separator */}
        <div className="pt-6 border-t border-surface-card">
          <p className="text-body text-sage-light max-w-2xl">
            {justification}
          </p>
        </div>
      </div>
    </section>
  );
}
