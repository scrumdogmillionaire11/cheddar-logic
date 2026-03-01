/**
 * SQUAD SECTION — Toggle View
 * 
 * Shows current squad with optional projected squad after transfers
 */

import React, { useState } from 'react';

interface Player {
  name: string;
  team?: string;
  position?: string;
  expected_pts?: number;
  is_new?: boolean;
}

interface SquadSectionProps {
  title: string;
  currentSquad: Player[];
  projectedSquad?: Player[];
  hasTransfers?: boolean;
}

const SquadSection: React.FC<SquadSectionProps> = ({
  title,
  currentSquad,
  projectedSquad = [],
  hasTransfers = false
}) => {
  const [view, setView] = useState<'current' | 'projected'>('current');
  
  const displaySquad = view === 'current' ? currentSquad : projectedSquad;
  const showToggle = hasTransfers && projectedSquad.length > 0;

  return (
    <section className="bg-surface-card border border-surface-elevated p-8">
      <div className="flex justify-between items-center mb-6">
        <h2 className="text-section text-sage-muted uppercase tracking-wider">{title}</h2>
        
        {showToggle && (
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => setView('current')}
              className={`px-4 py-2 text-body-sm font-medium rounded transition-all ${
                view === 'current'
                  ? 'bg-execute/20 text-execute border border-execute/50'
                  : 'bg-surface-elevated text-sage-muted border border-surface-elevated hover:text-sage-light'
              }`}
            >
              Current
            </button>
            <button
              type="button"
              onClick={() => setView('projected')}
              className={`px-4 py-2 text-body-sm font-medium rounded transition-all ${
                view === 'projected'
                  ? 'bg-execute/20 text-execute border border-execute/50'
                  : 'bg-surface-elevated text-sage-muted border border-surface-elevated hover:text-sage-light'
              }`}
            >
              After Transfers
            </button>
          </div>
        )}
      </div>

      {displaySquad.length === 0 ? (
        <p className="text-body-sm text-sage-muted italic">No data available</p>
      ) : (
        <div className="space-y-2">
          {displaySquad.map((player, idx) => (
            <div
              key={idx}
              className={`flex items-center justify-between p-3 rounded border ${
                player.is_new
                  ? 'bg-execute/10 border-execute/40'
                  : 'bg-surface-elevated border-surface-elevated'
              }`}
            >
              <div className="flex items-center gap-3">
                <span className="font-medium text-sage-white">
                  {player.name}
                  {player.is_new && (
                    <span className="ml-2 inline-flex items-center px-2 py-0.5 rounded text-meta font-semibold bg-execute/20 text-execute">
                      NEW
                    </span>
                  )}
                </span>
                <span className="text-body-sm text-sage-muted">
                  {player.team} • {player.position}
                </span>
              </div>
              <div className="text-right">
                <span className="text-body-sm font-semibold text-sage-white">
                  {player.expected_pts ? `${player.expected_pts.toFixed(1)} pts` : '-'}
                </span>
              </div>
            </div>
          ))}
        </div>
      )}

      {view === 'projected' && showToggle && (
        <p className="mt-4 text-body-sm text-sage-muted italic">
          Showing projected squad after applying all recommended transfers
        </p>
      )}
    </section>
  );
};

export default SquadSection;
