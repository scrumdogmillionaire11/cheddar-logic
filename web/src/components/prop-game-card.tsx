/**
 * PropGameCard Component
 *
 * Displays a game with all player prop projections listed as rows
 * Designed for player props view - shows multiple plays per game
 */

import type { PropGameCard, PropPlayRow } from '@/lib/types/game-card';
import { useState } from 'react';

interface PropGameCardProps {
  card: PropGameCard;
}

const formatTime = (isoString: string) => {
  const date = new Date(isoString);
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZone: 'America/New_York',
    timeZoneName: 'short',
  }).format(date);
};

const formatOdds = (americanOdds: number) => {
  return americanOdds > 0 ? `+${americanOdds}` : String(americanOdds);
};

const formatNumber = (value: number | null | undefined, digits = 1) => {
  if (value === null || value === undefined || Number.isNaN(value)) return '—';
  return value.toFixed(digits);
};

const getAverage = (values?: number[]) => {
  if (!values || values.length === 0) return null;
  const sum = values.reduce((acc, val) => acc + val, 0);
  return sum / values.length;
};

const getStatusColor = (status: PropPlayRow['status']) => {
  switch (status) {
    case 'FIRE':
      return 'text-execute border-execute/30 bg-execute/10';
    case 'WATCH':
      return 'text-teal border-teal/30 bg-teal/10';
    case 'HOLD':
      return 'text-yellow-400 border-yellow-400/30 bg-yellow-400/10';
    case 'NO_PLAY':
      return 'text-cloud/40 border-cloud/20 bg-cloud/5';
    default:
      return 'text-cloud/60 border-cloud/20 bg-cloud/5';
  }
};

const getStatusBadge = (status: PropPlayRow['status']) => {
  const baseClass = 'px-2 py-1 text-xs font-semibold rounded border';
  const colorClass = getStatusColor(status);
  return `${baseClass} ${colorClass}`;
};

export default function PropGameCardComponent({ card }: PropGameCardProps) {
  const [isExpanded, setIsExpanded] = useState(card.propPlays.length <= 5);

  const displayPlays = isExpanded ? card.propPlays : card.propPlays.slice(0, 5);
  const hasMore = card.propPlays.length > 5;

  return (
    <article className="rounded-xl border border-white/10 bg-night shadow-lg overflow-hidden">
      {/* Game Header */}
      <div className="px-6 py-4 border-b border-slate-700/50 bg-surface/30">
        <div className="flex items-center justify-between mb-2">
          <div className="flex items-center gap-3">
            <span className="px-2 py-1 text-xs font-bold uppercase tracking-wider bg-slate-700 text-slate-300 rounded">
              {card.sport}
            </span>
            <span className="text-sm font-semibold text-cloud/80">
              {formatTime(card.gameTimeUtc)}
            </span>
          </div>
        </div>

        <div className="text-lg font-bold text-sage-white">
          {card.awayTeam} @ {card.homeTeam}
        </div>

        {/* Optional odds context */}
        {(card.moneyline || card.total) && (
          <div className="mt-2 flex gap-4 text-xs text-cloud/60">
            {card.moneyline && (
              <span>
                ML: {card.homeTeam.split(' ').pop()}{' '}
                {formatOdds(card.moneyline.home)} /{' '}
                {card.awayTeam.split(' ').pop()}{' '}
                {formatOdds(card.moneyline.away)}
              </span>
            )}
            {card.total && <span>O/U {card.total.line}</span>}
          </div>
        )}
      </div>

      {/* Player Projections List */}
      <div className="px-6 py-4">
        <div className="mb-3 text-xs font-semibold uppercase tracking-wider text-cloud/60">
          Player Projections ({card.propPlays.length})
        </div>

        <div className="space-y-2">
          {displayPlays.map((prop, idx) => {
            const projectionValue = prop.mu ?? prop.projection;
            const lineValue = prop.suggestedLine ?? prop.line ?? prop.marketLine;
            const oddsInline =
              prop.priceOver != null || prop.priceUnder != null
                ? ` | O ${prop.priceOver != null ? formatOdds(prop.priceOver) : '—'} / U ${prop.priceUnder != null ? formatOdds(prop.priceUnder) : '—'}`
                : '';
            const contextLine1 = `Projection: ${formatNumber(projectionValue)} vs line ${formatNumber(lineValue)}`;
            const WARNING_FLAGS = ['SYNTHETIC_LINE', 'PROJECTION_ANOMALY'];
            const warningFlags = (prop.reasonCodes ?? []).filter((c) =>
              WARNING_FLAGS.includes(c),
            );
            const riskLine =
              warningFlags.length > 0
                ? `Risk: ${warningFlags
                    .map((flag) =>
                      flag === 'SYNTHETIC_LINE'
                        ? 'Synthetic line'
                        : 'Projection anomaly',
                    )
                    .join(' | ')}`
                : null;
            const hasDetails =
              warningFlags.length > 0 ||
              (prop.l5Sog && prop.l5Sog.length > 0) ||
              (prop.l5Mean !== null && prop.l5Mean !== undefined) ||
              (prop.priceOver != null || prop.priceUnder != null);

            return (
              <div
                key={`${prop.playerId}-${prop.propType}-${idx}`}
                className="rounded-lg border border-white/10 bg-surface/50 hover:border-white/20 transition"
              >
                <div className="px-4 py-3 space-y-3">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="font-semibold text-sage-white truncate">
                        {prop.playerName}
                      </div>
                      <div className="text-xs text-cloud/60">
                        {prop.propType}
                        {prop.teamAbbr ? ` · ${prop.teamAbbr}` : ''}
                      </div>
                    </div>
                    <span className={getStatusBadge(prop.status)}>{prop.status}</span>
                  </div>

                  <div className="rounded border border-white/10 bg-white/5 p-2.5">
                    <p className="text-sm font-semibold text-cloud">
                      {prop.playerName} {formatNumber(lineValue)}
                      {oddsInline}
                    </p>
                    <p className="text-xs text-cloud/65 mt-1">{contextLine1}</p>
                  </div>

                  {riskLine && (
                    <div className="rounded border border-white/10 bg-white/5 p-2.5">
                      <p className="text-xs text-cloud/75">{riskLine}</p>
                    </div>
                  )}

                  {hasDetails && (
                    <details className="rounded border border-white/10 bg-white/5 p-2.5">
                      <summary className="cursor-pointer text-[11px] uppercase tracking-widest text-cloud/45 font-semibold select-none">
                        Details
                      </summary>
                      <div className="mt-2 space-y-1.5 text-xs text-cloud/60">
                        {(prop.priceOver != null || prop.priceUnder != null) && (
                          <p>
                            Market odds: OVER{' '}
                            {prop.priceOver != null ? formatOdds(prop.priceOver) : '—'} / UNDER{' '}
                            {prop.priceUnder != null ? formatOdds(prop.priceUnder) : '—'}
                          </p>
                        )}
                        {((prop.l5Sog && prop.l5Sog.length > 0) ||
                          (prop.l5Mean !== null && prop.l5Mean !== undefined)) && (
                          <p>L5 average: {formatNumber(getAverage(prop.l5Sog), 1)}</p>
                        )}
                        {warningFlags.length > 0 && (
                          <div className="flex flex-wrap gap-1 pt-0.5">
                            {warningFlags.map((flag) => (
                              <span
                                key={flag}
                                className="rounded border border-amber-500/50 bg-amber-500/10 px-2 py-0.5 text-[10px] font-semibold text-amber-400"
                              >
                                {flag === 'SYNTHETIC_LINE'
                                  ? 'Synthetic line'
                                  : 'Projection anomaly'}
                              </span>
                            ))}
                          </div>
                        )}
                      </div>
                    </details>
                  )}
                </div>
              </div>
            );
          })}
        </div>

        {/* Expand/Collapse */}
        {hasMore && (
          <button
            onClick={() => setIsExpanded(!isExpanded)}
            className="mt-3 w-full py-2 text-xs font-semibold text-cloud/60 hover:text-cloud transition border border-white/10 rounded hover:border-white/20"
          >
            {isExpanded ? 'Show Less' : `Show All (${card.propPlays.length})`}
          </button>
        )}

        {/* Odds Updated Footer */}
        {card.oddsUpdatedUtc && (
          <div className="mt-4 pt-3 border-t border-white/10 text-xs text-cloud/40">
            Odds updated {formatTime(card.oddsUpdatedUtc)}
          </div>
        )}
      </div>
    </article>
  );
}
