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

const formatBookName = (book: string | null | undefined): string => {
  if (!book) return '';
  const names: Record<string, string> = {
    betmgm: 'BetMGM',
    draftkings: 'DraftKings',
    fanduel: 'FanDuel',
    williamhill_us: 'Caesars',
    espnbet: 'ESPN Bet',
    fliff: 'Fliff',
    pinnacle: 'Pinnacle',
    fanatics: 'Fanatics',
    hardrockbet: 'Hard Rock',
  };
  return names[book] ?? book;
};

const formatNumber = (value: number | null | undefined, digits = 1) => {
  if (value === null || value === undefined || Number.isNaN(value)) return '—';
  return value.toFixed(digits);
};

const formatPercent = (value: number | null | undefined, digits = 1) => {
  if (value === null || value === undefined || Number.isNaN(value)) return '—';
  return `${(value * 100).toFixed(digits)}%`;
};

const getAverage = (values?: number[]) => {
  if (!values || values.length === 0) return null;
  const sum = values.reduce((acc, val) => acc + val, 0);
  return sum / values.length;
};

const getVerdictColor = (verdict: PropPlayRow['propVerdict']) => {
  switch (verdict) {
    case 'PLAY':
      return 'text-execute border-execute/40 bg-execute/10';
    case 'WATCH':
      return 'text-teal border-teal/40 bg-teal/10';
    case 'NO_PLAY':
      return 'text-amber-300 border-amber-400/30 bg-amber-400/10';
    case 'PROJECTION':
      return 'text-cloud/55 border-cloud/20 bg-cloud/5';
    default:
      return 'text-cloud/60 border-cloud/20 bg-cloud/5';
  }
};

const getVerdictBadge = (verdict: PropPlayRow['propVerdict']) => {
  const baseClass = 'px-2 py-1 text-xs font-semibold rounded border';
  const colorClass = getVerdictColor(verdict);
  return `${baseClass} ${colorClass}`;
};

const getVerdictLabel = (verdict: PropPlayRow['propVerdict']) => {
  if (verdict === 'NO_PLAY') return 'NO PLAY';
  return verdict ?? 'NO PLAY';
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
            const verdict = prop.propVerdict ?? 'NO_PLAY';
            const leanSide =
              prop.leanSide ??
              ((projectionValue ?? 0) >= (lineValue ?? 0) ? 'OVER' : 'UNDER');
            const heroOdds =
              typeof prop.displayPrice === 'number'
                ? ` (${formatOdds(prop.displayPrice)})`
                : '';
            const heroLine =
              verdict === 'PROJECTION'
                ? `PROJECTION ${leanSide} ${formatNumber(lineValue)}`
                : `LEAN ${leanSide} ${formatNumber(lineValue)}${heroOdds}`;
            const WARNING_FLAGS = ['SYNTHETIC_LINE', 'PROJECTION_ANOMALY'];
            const warningFlags = [...new Set([...(prop.propFlags ?? []), ...(prop.reasonCodes ?? [])])].filter((c) =>
              WARNING_FLAGS.includes(c),
            );
            const hasDetails =
              warningFlags.length > 0 ||
              (prop.l5Sog && prop.l5Sog.length > 0) ||
              (prop.l5Mean !== null && prop.l5Mean !== undefined) ||
              (prop.priceOver != null || prop.priceUnder != null) ||
              (prop.propFlags && prop.propFlags.length > 0);
            const projectionDeltaText =
              typeof prop.lineDelta === 'number'
                ? `${prop.lineDelta >= 0 ? '+' : ''}${prop.lineDelta.toFixed(1)} vs line`
                : '—';
            const trendLabel = prop.l5Trend ?? 'stable';
            const trendText =
              prop.l5Mean !== null && prop.l5Mean !== undefined
                ? `${formatNumber(prop.l5Mean)} (${trendLabel})`
                : '—';

            return (
              <div
                key={`${prop.playerId}-${prop.propType}-${idx}`}
                className={`rounded-lg border bg-surface/50 transition ${
                  verdict === 'PLAY'
                    ? 'border-execute/30 hover:border-execute/50'
                    : verdict === 'WATCH'
                      ? 'border-teal/25 hover:border-teal/45'
                      : verdict === 'NO_PLAY'
                        ? 'border-amber-400/20 hover:border-amber-400/35'
                        : 'border-white/10 hover:border-white/20'
                }`}
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
                    <span className={getVerdictBadge(verdict)}>
                      {getVerdictLabel(verdict)}
                    </span>
                  </div>

                  <div className="rounded-md border border-white/10 bg-white/5 p-3">
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <p className="text-sm font-semibold uppercase tracking-[0.12em] text-cloud/55">
                          {prop.playerName} — {prop.propType}
                        </p>
                        <p className="mt-1 text-lg font-bold text-cloud">
                          {heroLine}
                        </p>
                      </div>
                      {typeof prop.probEdgePp === 'number' && (
                        <div className="text-right">
                          <div className="text-[11px] uppercase tracking-[0.12em] text-cloud/45">
                            Edge
                          </div>
                          <div
                            className={`text-sm font-semibold ${
                              prop.probEdgePp > 0
                                ? 'text-execute'
                                : 'text-cloud/70'
                            }`}
                          >
                            {formatPercent(prop.probEdgePp)}
                          </div>
                        </div>
                      )}
                    </div>
                    <p className="mt-2 text-xs text-cloud/70">
                      {prop.propWhy ?? prop.reasoning ?? 'No prop reason available.'}
                    </p>
                  </div>

                  <div className="grid gap-2 md:grid-cols-3">
                    <div className="rounded border border-white/10 bg-night/40 p-3">
                      <div className="text-[11px] uppercase tracking-[0.12em] text-cloud/45">
                        Projection
                      </div>
                      <div className="mt-2 space-y-1 text-sm text-cloud/80">
                        <p>Proj: {formatNumber(projectionValue)}</p>
                        <p>{projectionDeltaText}</p>
                        <p>L5: {trendText}</p>
                      </div>
                    </div>

                    <div className="rounded border border-white/10 bg-night/40 p-3">
                      <div className="text-[11px] uppercase tracking-[0.12em] text-cloud/45">
                        Market
                      </div>
                      <div className="mt-2 space-y-1 text-sm text-cloud/80">
                        <p>Line: {formatNumber(lineValue)}</p>
                        <p>
                          Over{' '}
                          {prop.priceOver != null ? formatOdds(prop.priceOver) : '—'}
                        </p>
                        <p>
                          Under{' '}
                          {prop.priceUnder != null ? formatOdds(prop.priceUnder) : '—'}
                        </p>
                        {prop.bookmaker && (
                          <p className="text-cloud/40">
                            via {formatBookName(prop.bookmaker)}
                          </p>
                        )}
                      </div>
                    </div>

                    <div className="rounded border border-white/10 bg-night/40 p-3">
                      <div className="text-[11px] uppercase tracking-[0.12em] text-cloud/45">
                        Edge
                      </div>
                      <div className="mt-2 space-y-1 text-sm text-cloud/80">
                        <p>Fair: {formatPercent(prop.fairProb)}</p>
                        <p>Implied: {formatPercent(prop.impliedProb)}</p>
                        <p>Edge: {formatPercent(prop.probEdgePp)}</p>
                        <p>EV: {formatNumber(prop.ev, 2)}</p>
                      </div>
                    </div>
                  </div>

                  {hasDetails && (
                    <details className="rounded border border-white/10 bg-white/5 p-2.5">
                      <summary className="cursor-pointer text-[11px] uppercase tracking-widest text-cloud/45 font-semibold select-none">
                        Details
                      </summary>
                      <div className="mt-2 space-y-1.5 text-xs text-cloud/60">
                        {prop.propFlags && prop.propFlags.length > 0 && (
                          <p>Flags: {prop.propFlags.join(' | ')}</p>
                        )}
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
