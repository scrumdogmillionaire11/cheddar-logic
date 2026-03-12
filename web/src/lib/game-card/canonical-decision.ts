/**
 * CANONICAL DECISION OBJECT
 *
 * Single source of truth for card display.
 * Everything else is derived from this object.
 */

import { resolvePlayDisplayDecision } from './decision';
import type { ExpressionStatus } from '@/lib/types/game-card';

export type Decision = 'FIRE' | 'WATCH' | 'HOLD' | 'PASS';
export type Signal = 'STRONG' | 'MEDIUM' | 'WEAK';
export type Value = 'GOOD' | 'OK' | 'BAD';
export type CanonicalMarket = 'MONEYLINE' | 'SPREAD' | 'TOTAL' | 'NONE';

export interface Bet {
  market: CanonicalMarket;
  selection: 'HOME' | 'AWAY' | 'OVER' | 'UNDER' | null;
  line?: number | null;
  price?: number | null;
  /** Derived: "Team ML -110" or "Over 45.5 -110" or null if PASS */
  pick: string | null;
}

export interface CardDecision {
  // PRIMARY SOURCE OF TRUTH: what the user should do
  decision: Decision;

  // THE BET: null if decision === PASS
  bet: Bet | null;

  // STRENGTH & VALUE SIGNALS
  signal: Signal;
  value: Value;

  // CONTRACT VALIDATION
  contractViolations: string[];

  // DIAGNOSTIC INFO
  decidedAt: string; // ISO timestamp
  source?: 'model' | 'expression-legacy' | 'fallback';
}

/**
 * Compute canonical decision from a Play object
 * Validates contracts and returns violations list
 */
export function computeCanonicalDecision(play: {
  action?: 'FIRE' | 'HOLD' | 'PASS';
  market_type?: string;
  selection?: { side?: string };
  line?: number;
  price?: number;
  pick?: string;
  status?: ExpressionStatus;
  market?: string;
  tier?: string;
  confidence?: number;
  valueStatus?: string;
}): CardDecision {
  const violations: string[] = [];

  // 1. DECISION: Resolve from canonical action precedence (action -> legacy status)
  const resolvedAction = resolvePlayDisplayDecision({
    action: play.action,
    status: play.status,
  }).action;
  let decision: Decision = 'PASS';
  if (resolvedAction === 'FIRE') {
    decision = 'FIRE';
  } else if (resolvedAction === 'HOLD') {
    decision = 'HOLD';
  }

  // 2. MARKET & BET: Canonical market from market_type, fallback to market
  let market: CanonicalMarket = 'NONE';
  if (play.market_type === 'MONEYLINE' || play.market === 'ML') {
    market = 'MONEYLINE';
  } else if (play.market_type === 'SPREAD' || play.market === 'SPREAD') {
    market = 'SPREAD';
  } else if (play.market_type === 'TOTAL' || play.market === 'TOTAL') {
    market = 'TOTAL';
  }

  // Build bet object (null if PASS)
  let bet: Bet | null = null;
  if (decision !== 'PASS' && market !== 'NONE') {
    const selection = (play.selection?.side || play.selection?.side) as
      | 'HOME'
      | 'AWAY'
      | 'OVER'
      | 'UNDER'
      | null;
    const pick = inferPickFromPlay(market, selection, play.line, play.price);

    bet = {
      market,
      selection,
      line: play.line ?? undefined,
      price: play.price ?? undefined,
      pick,
    };
  }

  // 3. SIGNAL: Infer from tier/confidence
  let signal: Signal = 'WEAK';
  if (play.tier === 'SUPER') {
    signal = 'STRONG';
  } else if (play.tier === 'BEST') {
    signal = 'STRONG';
  } else if (play.tier === 'WATCH') {
    signal = 'MEDIUM';
  } else if (typeof play.confidence === 'number') {
    if (play.confidence >= 0.75) {
      signal = 'STRONG';
    } else if (play.confidence >= 0.6) {
      signal = 'MEDIUM';
    } else {
      signal = 'WEAK';
    }
  }

  // 4. VALUE: Map from valueStatus
  let value: Value = 'OK';
  if (play.valueStatus === 'GOOD') {
    value = 'GOOD';
  } else if (play.valueStatus === 'BAD') {
    value = 'BAD';
  } else {
    value = 'OK';
  }

  // 5. CONTRACT VALIDATION
  // Rule 1: decision != PASS implies bet must exist
  if (decision !== 'PASS' && !bet) {
    violations.push(`decision=${decision} but bet=null (invalid)`);
  }

  // Rule 2: decision == PASS implies bet must be null
  if (decision === 'PASS' && bet) {
    violations.push(`decision=PASS but bet exists (invalid)`);
  }

  // Rule 3: FIRE requires STRONG signal and GOOD value
  if (decision === 'FIRE') {
    if (signal !== 'STRONG') {
      violations.push(`decision=FIRE but signal=${signal} (should be STRONG)`);
    }
    if (value !== 'GOOD') {
      violations.push(`decision=FIRE but value=${value} (should be GOOD)`);
    }
  }

  // Rule 4: BAD value cannot be FIRE (max HOLD)
  if (value === 'BAD' && decision === 'FIRE') {
    violations.push(`value=BAD cannot yield decision=FIRE (max is HOLD)`);
  }

  // Rule 5: WEAK signal cannot be FIRE
  if (signal === 'WEAK' && decision === 'FIRE') {
    violations.push(`signal=WEAK cannot yield decision=FIRE (max is WATCH)`);
  }

  // Rule 6: Bet market must exist if bet exists
  if (bet && bet.market === 'NONE') {
    violations.push(`bet exists but market=NONE (invalid)`);
  }

  // Rule 7: Bet selection must match market
  if (bet) {
    if (
      (bet.market === 'MONEYLINE' &&
        !['HOME', 'AWAY'].includes(bet.selection || '')) ||
      (bet.market === 'SPREAD' &&
        !['HOME', 'AWAY'].includes(bet.selection || '')) ||
      (bet.market === 'TOTAL' &&
        !['OVER', 'UNDER'].includes(bet.selection || ''))
    ) {
      violations.push(
        `bet selection=${bet.selection} invalid for market=${bet.market}`,
      );
    }
  }

  return {
    decision,
    bet,
    signal,
    value,
    contractViolations: violations,
    decidedAt: new Date().toISOString(),
    source: play.action ? 'model' : 'expression-legacy',
  };
}

function inferPickFromPlay(
  market: CanonicalMarket,
  selection: string | null,
  line: number | undefined,
  price: number | undefined,
): string | null {
  if (!selection) return null;

  let label = '';
  if (market === 'MONEYLINE') {
    label = `${selection} ML`;
  } else if (market === 'SPREAD') {
    if (line !== undefined) {
      const sign = line > 0 ? '+' : '';
      label = `${selection} ${sign}${line}`;
    } else {
      label = `${selection} Spread`;
    }
  } else if (market === 'TOTAL') {
    if (line !== undefined) {
      label = `${selection} ${line}`;
    } else {
      label = `${selection} Total`;
    }
  }

  if (price !== undefined) {
    const priceStr = price > 0 ? `+${price}` : `${price}`;
    label += ` ${priceStr}`;
  }

  return label || null;
}

/**
 * Derive classification label from decision (for legacy compat)
 */
export function classificationFromDecision(
  decision: Decision,
): 'BASE' | 'LEAN' | 'PASS' {
  if (decision === 'FIRE') return 'BASE';
  if (decision === 'HOLD' || decision === 'WATCH') return 'LEAN';
  return 'PASS';
}

/**
 * Display helper for decision label
 */
export function formatDecision(decision: Decision): string {
  return decision.toUpperCase();
}

/**
 * Display helper for signal label
 */
export function formatSignal(signal: Signal): string {
  return signal.toUpperCase();
}

/**
 * Display helper for value label
 */
export function formatValue(value: Value): string {
  return value.toUpperCase();
}

/**
 * Color class for decision badge
 */
export function getDecisionColorClass(decision: Decision): string {
  switch (decision) {
    case 'FIRE':
      return 'bg-green-900/50 text-green-200 border-green-700/60';
    case 'WATCH':
    case 'HOLD':
      return 'bg-yellow-900/50 text-yellow-200 border-yellow-700/60';
    case 'PASS':
      return 'bg-slate-900/50 text-slate-200 border-slate-700/60';
    default:
      return 'bg-slate-900/50 text-slate-200 border-slate-700/60';
  }
}
