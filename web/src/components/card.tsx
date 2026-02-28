/**
 * Unified Betting Card Component (Adopted from Personal-Dashboard)
 * 
 * Renders betting cards with structured display sections:
 * 1. SignalHeaderBar (sport, confidence signal)
 * 2. Confidence Bar (visual 0-100%)
 * 3. PlayBlock (PLAY/LEAN/PASS status)
 * 4. DriverPanel (reasoning)
 * 5. AlertBlock (warnings, EV status)
 * 6. Odds Context (organized by market type)
 * 7. Expandable Details (audit layer)
 */

import React, { useState } from 'react';

export interface CardPayloadData {
  game_id: string;
  sport: string;
  model_version: string;
  prediction: string;
  confidence: number;
  recommendation?: {
    type: string;
    text: string;
    pass_reason?: string | null;
  };
  projection?: {
    total?: number | null;
    margin_home?: number | null;
    win_prob_home?: number | null;
  };
  market?: {
    total_line?: number | null;
    spread_home?: number | null;
    moneyline_home?: string | null;
    moneyline_away?: string | null;
  } | null;
  edge?: {
    value: number;
    units?: string | null;
  } | null;
  confidence_pct?: number;
  home_team?: string | null;
  away_team?: string | null;
  matchup?: string | null;
  start_time_utc?: string | null;
  start_time_local?: string | null;
  timezone?: string | null;
  countdown?: string | null;
  recommended_bet_type?: string;
  reasoning: string;
  odds_context: {
    h2h_home?: number;
    h2h_away?: number;
    spread_home?: number;
    spread_away?: number;
    total?: number;
    draw_odds?: number;
    captured_at: string;
  };
  ev_passed: boolean;
  disclaimer: string;
  generated_at: string;
  drivers_active?: string[];
  tier?: string | null;
  driver?: {
    key?: string;
    score?: number;
    status?: string;
    inputs?: Record<string, unknown>;
  } | null;
  driver_summary?: {
    weights?: Array<{
      driver: string;
      weight: number;
      score?: number | null;
      impact?: number | null;
      status?: string | null;
    }>;
    impact_note?: string | null;
  } | null;
  meta?: {
    inference_source?: string;
    model_endpoint?: string | null;
    is_mock?: boolean;
  };
}

export interface CardProps {
  id: string;
  gameId: string;
  sport: string;
  cardType: string;
  cardTitle: string;
  createdAt: string;
  expiresAt: string | null;
  payloadData: CardPayloadData;
  payloadParseError?: boolean;
  modelOutputIds?: string | null;
}

function isCardExpired(expiresAt: string | null): boolean {
  if (!expiresAt) return false;
  return new Date(expiresAt).getTime() <= Date.now();
}
/**
 * Get recommendation level (PLAY / LEAN / PASS)
 * PLAY: ≥70%, LEAN: 60-69%, PASS: <60%
 */
function getRecommendationLevel(confidence: number): 'PLAY' | 'LEAN' | 'PASS' {
  if (confidence >= 0.7) return 'PLAY';
  if (confidence >= 0.6) return 'LEAN';
  return 'PASS';
}

/**
 * Get accent color for recommendation level
 * PLAY = green, LEAN = amber, PASS = slate
 */
function getAccentColor(confidence: number): {
  border: string;
  bg: string;
  text: string;
  bar: string;
  label: string;
} {
  if (confidence >= 0.7) {
    return {
      border: 'border-green-500/60',
      bg: 'bg-green-500/10',
      text: 'text-green-300',
      bar: 'bg-green-500',
      label: 'text-green-400 font-semibold'
    };
  }
  if (confidence >= 0.6) {
    return {
      border: 'border-amber-500/60',
      bg: 'bg-amber-500/10',
      text: 'text-amber-300',
      bar: 'bg-amber-500',
      label: 'text-amber-400 font-semibold'
    };
  }
  return {
    border: 'border-slate-500/60',
    bg: 'bg-slate-500/10',
    text: 'text-slate-300',
    bar: 'bg-slate-500',
    label: 'text-slate-400'
  };
}

/**
 * Format confidence as percentage
 */
function formatConfidence(confidence: number): string {
  return `${Math.round(confidence * 100)}%`;
}

/**
 * Format timestamp for display
 */
function formatTimestamp(iso: string): string {
  const date = new Date(iso);
  return date.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true });
}

function formatEdge(value: number, units?: string | null): string {
  if (units === 'pts') return `${value.toFixed(1)} pts`;
  if (units === 'prob') return `${(value * 100).toFixed(1)}%`;
  if (units === 'ev') return `${value.toFixed(2)} ev`;
  return `${value}`;
}

export default function Card({ 
  id, 
  gameId, 
  sport, 
  cardTitle,
  createdAt,
  expiresAt, 
  payloadData,
  modelOutputIds
}: CardProps) {
  const [expanded, setExpanded] = useState(false);
  const expired = isCardExpired(expiresAt);
  const recommendationType = payloadData.recommendation?.type ?? null;
  const passReason = payloadData.recommendation?.pass_reason ?? null;
  const hasPass = recommendationType === 'PASS';
  const recommendation = hasPass ? 'PASS' : getRecommendationLevel(payloadData.confidence);
  const accentColor = getAccentColor(hasPass ? 0 : payloadData.confidence);
  const confidencePercent = formatConfidence(payloadData.confidence);
  const generatedTime = formatTimestamp(payloadData.generated_at);
  const edgeValue = payloadData.edge?.value ?? null;
  const edgeUnits = payloadData.edge?.units ?? null;
  const hasMoneyline =
    payloadData.odds_context?.h2h_home !== undefined ||
    payloadData.odds_context?.h2h_away !== undefined;
  const hasSpread =
    payloadData.odds_context?.spread_home !== undefined ||
    payloadData.odds_context?.spread_away !== undefined;

  return (
    <article 
      className={`rounded-xl border transition ${
        expired 
          ? 'border-slate-700 bg-slate-900/50 opacity-60' 
          : `border-l-4 ${accentColor.border} bg-night shadow-lg`
      } overflow-hidden`}
      data-card-id={id}
      data-game-id={gameId}
      data-recommendation={recommendation}
    >
      {/* === SIGNAL HEADER BAR === */}
      <div className="px-6 py-4 border-b border-slate-700/50 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className={`px-3 py-1 rounded-lg ${accentColor.bg} ${accentColor.text} text-xs font-mono font-semibold`}>
            {sport}
          </div>
          <div className="flex-1">
            <h3 className="text-sm font-semibold text-cloud">
              {cardTitle}
            </h3>
          </div>
        </div>

        <div className="flex items-center gap-2">
          {payloadData.meta?.is_mock && (
            <span className="px-2 py-1 text-xs bg-slate-700/50 text-slate-300 rounded border border-slate-600">
              MOCK
            </span>
          )}
          <span className={`px-3 py-1 rounded-lg font-bold text-sm ${accentColor.bg} ${accentColor.label}`}>
            {recommendation}
          </span>
        </div>
      </div>

      {/* === CONFIDENCE BAR === */}
      <div className="px-6 py-3 bg-slate-900/30 border-b border-slate-700/50">
        <div className="space-y-2">
          <div className="flex items-center justify-between text-xs">
            <span className="text-slate-400">Confidence</span>
            <span className={`${accentColor.label}`}>{confidencePercent}</span>
          </div>
          <div className="w-full h-2 bg-slate-700/50 rounded-full overflow-hidden">
            <div
              className={`h-full ${accentColor.bar} transition-all duration-300`}
              style={{ width: `${payloadData.confidence * 100}%` }}
            />
          </div>
        </div>
      </div>

      {/* === PLAY BLOCK === */}
      <div className={`px-6 py-4 border-b border-slate-700/50 ${accentColor.bg}`}>
        <div className="space-y-2">
          <div className="flex items-baseline gap-2">
            <span className="text-3xl font-bold text-cloud">
              {hasPass ? 'PASS' : payloadData.prediction}
            </span>
            {payloadData.recommended_bet_type && (
              <span className="text-sm text-slate-400">
                {payloadData.recommended_bet_type}
              </span>
            )}
          </div>
          {payloadData.recommendation?.text && !hasPass && (
            <p className="text-xs text-slate-400">
              {payloadData.recommendation.text}
            </p>
          )}
          {edgeValue != null && !hasPass && (
            <p className="text-xs text-slate-300">
              Edge: <span className="font-mono text-cloud">{formatEdge(edgeValue, edgeUnits)}</span>
            </p>
          )}
          {hasPass && passReason && (
            <p className="text-xs text-amber-200">
              Pass reason: {passReason}
            </p>
          )}
          <p className="text-xs text-slate-400">
            Model: {payloadData.model_version}
          </p>
        </div>
      </div>

      {/* === DRIVER PANEL === */}
      <div className="px-6 py-4 border-b border-slate-700/50 space-y-2">
        <p className="text-xs text-slate-400 font-mono uppercase tracking-wider">Why</p>
        <p className="text-sm text-slate-200 leading-relaxed">
          {payloadData.reasoning}
        </p>
      </div>

      {/* === ALERT BLOCK === */}
      <div className={`px-6 py-3 border-b border-slate-700/50 flex items-center gap-3 ${
        hasPass ? 'bg-slate-900/30' : payloadData.ev_passed ? 'bg-green-900/20' : 'bg-amber-900/20'
      }`}>
        <div className={`w-2 h-2 rounded-full ${
          hasPass ? 'bg-slate-500' : payloadData.ev_passed ? 'bg-green-500' : 'bg-amber-500'
        }`} />
        <span className={`text-xs font-medium ${
          hasPass ? 'text-slate-300' : payloadData.ev_passed ? 'text-green-300' : 'text-amber-300'
        }`}>
          {hasPass ? 'PASS — no recommended market' : payloadData.ev_passed ? '✓ EV Threshold Passed' : '⚠ Low Expected Value'}
        </span>
      </div>

      {/* === ODDS CONTEXT === */}
      {payloadData.odds_context && (
        <div className="px-6 py-4 border-b border-slate-700/50 space-y-3">
          <div className="flex items-center justify-between">
            <p className="text-xs text-slate-400 font-mono uppercase tracking-wider">Market Snapshot</p>
            <p className="text-xs text-slate-500">
              {formatTimestamp(payloadData.odds_context.captured_at)}
            </p>
          </div>
          
          {(hasMoneyline || hasSpread) && (
            <div className={`grid gap-4 ${hasMoneyline && hasSpread ? 'grid-cols-2' : 'grid-cols-1'}`}>
              {hasMoneyline && (
                <div className="bg-slate-900/50 rounded-lg p-3 border border-slate-700/50">
                  <p className="text-xs text-slate-500 mb-1">Moneyline</p>
                  <div className="space-y-1 text-sm">
                    {payloadData.odds_context.h2h_home !== undefined && (
                      <div className="flex justify-between">
                        <span className="text-slate-400">Home</span>
                        <span className="text-cloud font-mono">{payloadData.odds_context.h2h_home > 0 ? '+' : ''}{payloadData.odds_context.h2h_home}</span>
                      </div>
                    )}
                    {payloadData.odds_context.h2h_away !== undefined && (
                      <div className="flex justify-between">
                        <span className="text-slate-400">Away</span>
                        <span className="text-cloud font-mono">{payloadData.odds_context.h2h_away > 0 ? '+' : ''}{payloadData.odds_context.h2h_away}</span>
                      </div>
                    )}
                  </div>
                </div>
              )}
              {hasSpread && (
                <div className="bg-slate-900/50 rounded-lg p-3 border border-slate-700/50">
                  <p className="text-xs text-slate-500 mb-1">Spread</p>
                  <div className="space-y-1 text-sm">
                    {payloadData.odds_context.spread_home !== undefined && (
                      <div className="flex justify-between">
                        <span className="text-slate-400">Home</span>
                        <span className="text-cloud font-mono">{payloadData.odds_context.spread_home > 0 ? '+' : ''}{payloadData.odds_context.spread_home}</span>
                      </div>
                    )}
                    {payloadData.odds_context.spread_away !== undefined && (
                      <div className="flex justify-between">
                        <span className="text-slate-400">Away</span>
                        <span className="text-cloud font-mono">{payloadData.odds_context.spread_away > 0 ? '+' : ''}{payloadData.odds_context.spread_away}</span>
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>
          )}
          
          {payloadData.odds_context.total !== undefined && (
            <div className="bg-slate-900/50 rounded-lg p-3 border border-slate-700/50">
              <p className="text-xs text-slate-500 mb-1">Total</p>
              <p className="text-sm text-cloud font-mono">{payloadData.odds_context.total}</p>
            </div>
          )}
        </div>
      )}

      {/* === DISCLAIMER === */}
      <div className="px-6 py-3 bg-amber-900/20 border-b border-slate-700/50">
        <p className="text-xs text-amber-100/80 leading-relaxed">
          {payloadData.disclaimer}
        </p>
      </div>

      {/* === EXPANDABLE DETAILS === */}
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full px-6 py-3 text-xs text-slate-400 hover:text-slate-300 hover:bg-slate-900/30 transition flex items-center justify-between font-mono uppercase tracking-wider"
      >
        <span>Audit Details</span>
        <span className={`transition-transform ${expanded ? 'rotate-180' : ''}`}>▼</span>
      </button>

      {expanded && (
        <div className="px-6 py-4 bg-slate-900/30 border-t border-slate-700/50 space-y-3 text-xs">
          <div className="grid grid-cols-2 gap-4">
            <div>
              <p className="text-slate-500 mb-1">Card ID</p>
              <p className="text-slate-300 font-mono break-all">{id.slice(0, 20)}...</p>
            </div>
            <div>
              <p className="text-slate-500 mb-1">Generated</p>
              <p className="text-slate-300 font-mono">{generatedTime}</p>
            </div>
            <div>
              <p className="text-slate-500 mb-1">Game ID</p>
              <p className="text-slate-300 font-mono break-all">{gameId}</p>
            </div>
            <div>
              <p className="text-slate-500 mb-1">Created</p>
              <p className="text-slate-300 font-mono">{formatTimestamp(createdAt)}</p>
            </div>
            {payloadData.meta?.inference_source && (
              <div>
                <p className="text-slate-500 mb-1">Inference</p>
                <p className="text-slate-300 font-mono capitalize">{payloadData.meta.inference_source}</p>
              </div>
            )}
            {expiresAt && (
              <div>
                <p className="text-slate-500 mb-1">Expires</p>
                <p className="text-slate-300 font-mono">{new Date(expiresAt).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true })}</p>
              </div>
            )}
          </div>
          {payloadData.driver_summary?.weights && payloadData.driver_summary.weights.length > 0 && (
            <div>
              <p className="text-slate-500 mb-1">Driver Weights</p>
              <div className="space-y-1">
                {payloadData.driver_summary.weights.map((item, index) => (
                  <div key={`${item.driver}-${index}`} className="flex items-center justify-between text-slate-300 font-mono">
                    <span>{item.driver}</span>
                    <span>
                      w={item.weight.toFixed(2)}
                      {item.score != null ? `, s=${item.score.toFixed(2)}` : ''}
                      {item.impact != null ? `, impact=${item.impact.toFixed(3)}` : ''}
                    </span>
                  </div>
                ))}
              </div>
              {payloadData.driver_summary.impact_note && (
                <p className="text-slate-500 mt-2">{payloadData.driver_summary.impact_note}</p>
              )}
            </div>
          )}
          {modelOutputIds && (
            <div>
              <p className="text-slate-500 mb-1">Model Output IDs</p>
              <p className="text-slate-300 font-mono break-all">{modelOutputIds}</p>
            </div>
          )}
        </div>
      )}

      {expired && (
        <div className="px-6 py-3 bg-red-900/20 border-t border-slate-700/50">
          <p className="text-xs text-red-300 font-medium">⏱ This card has expired</p>
        </div>
      )}
    </article>
  );
}
