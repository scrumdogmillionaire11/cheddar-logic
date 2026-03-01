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
}

export default function DecisionBrief({ 
  primaryAction, 
  confidence, 
  justification,
  gameweek 
}: DecisionBriefProps) {
  const getConfidenceColor = () => {
    switch (confidence) {
      case 'HIGH': return 'text-execute';
      case 'MED': return 'text-hold';
      case 'LOW': return 'text-veto';
      default: return 'text-sage-white';
    }
  };

  // Get user-friendly descriptions
  const actionKey = primaryAction.toUpperCase() as keyof typeof ACTION_DESCRIPTIONS;
  const actionDesc = ACTION_DESCRIPTIONS[actionKey];
  const confidenceDesc = CONFIDENCE_DESCRIPTIONS[confidence];

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
              {confidenceDesc?.short || `${confidence} Confidence`}
            </div>
          </div>
          {confidenceDesc && (
            <p className="text-body-sm text-sage-muted italic">
              {confidenceDesc.long}
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
