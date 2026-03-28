/**
 * Driver role registry and consensus scoring for gate-based decision logic.
 *
 * Separates model edge (tier) from driver support (consensus) so that a single
 * loud driver cannot hijack the play status.
 */

import type { DriverRow, Direction, DriverTier, SupportGrade } from '../types/game-card';

// ---------------------------------------------------------------------------
// Driver role registry — keyed by card_type from DB
// ---------------------------------------------------------------------------

export type DriverRole = 'PRIMARY' | 'CONTEXT' | 'RISK';

/**
 * PRIMARY drivers can support a play directly.
 * CONTEXT drivers can only boost or reduce confidence — they cannot create a play alone.
 * RISK drivers only block, downgrade, or warn — they never contribute positive score.
 * Unknown card types default to CONTEXT.
 */
export const DRIVER_ROLES: Record<string, DriverRole> = {
  // PRIMARY
  'nba-base-projection':   'PRIMARY',
  'nba-totals-call':       'PRIMARY',
  'nba-total-projection':  'PRIMARY',
  'nba-spread-call':       'PRIMARY',
  'nhl-moneyline-call':    'PRIMARY',
  'nhl-totals-call':       'PRIMARY',
  'nhl-spread-call':       'PRIMARY',
  'nhl-pace-totals':       'PRIMARY',
  'nhl-pace-1p':           'PRIMARY',
  'ncaam-base-projection': 'PRIMARY',
  'ncaam-ft-trend':        'PRIMARY',
  'ncaam-ft-spread':       'PRIMARY',
  'nhl-player-shots':      'PRIMARY',
  'nhl-player-shots-1p':   'PRIMARY',

  // CONTEXT — boost/reduce only
  'nba-rest-advantage':  'CONTEXT',
  'nba-matchup-style':   'CONTEXT',
  'nhl-base-projection': 'CONTEXT',
  'nhl-goalie':          'CONTEXT',
  'nhl-goalie-certainty':'CONTEXT',
  'nhl-lineup':          'CONTEXT',
  'nhl-shot-environment':'CONTEXT',
  'nhl-model-output':    'CONTEXT',
  'nhl-rest-advantage':  'CONTEXT',
  'welcome-home':        'CONTEXT',
  'welcome-home-v2':     'CONTEXT', // alias: backward compat with existing DB rows
  'ncaam-rest-advantage': 'CONTEXT',
  'ncaam-matchup-style': 'CONTEXT',

  // RISK — never contributes positive score
  'nba-blowout-risk': 'RISK',
};

// ---------------------------------------------------------------------------
// Scoring weights and gate thresholds
// ---------------------------------------------------------------------------

export const TIER_WEIGHTS: Record<DriverTier, number> = {
  BEST:  1.00,
  SUPER: 0.70,
  WATCH: 0.40,
};

export const GATE = {
  FIRE_NET_SUPPORT:   1.4,
  FIRE_CONFLICT_MAX:  0.35,
  WATCH_NET_SUPPORT:  0.7,
  WATCH_CONFLICT_MAX: 0.75,
} as const;

const OPPOSITE_DIRECTION: Partial<Record<Direction, Direction>> = {
  HOME:  'AWAY',
  AWAY:  'HOME',
  OVER:  'UNDER',
  UNDER: 'OVER',
};

// ---------------------------------------------------------------------------
// Support score computation
// ---------------------------------------------------------------------------

export type SupportScore = {
  support_score:  number;       // sum of aligned driver weights
  contra_score:   number;       // sum of opposing driver weights
  net_support:    number;       // support_score - contra_score
  conflict_ratio: number;       // contra_score / max(support_score, 0.01)
  primary_count:  number;       // aligned PRIMARY-role drivers
  support_grade:  SupportGrade; // STRONG / MIXED / WEAK
};

/**
 * Compute weighted support scores for a given direction across all drivers.
 *
 * - RISK-role drivers are excluded from scoring entirely.
 * - NEUTRAL-direction drivers are excluded.
 * - Drivers aligned with `direction` contribute to support_score.
 * - Drivers aligned with the opposite direction contribute to contra_score.
 * - primary_count counts aligned PRIMARY-role drivers only.
 */
export function computeSupportScores(
  drivers: DriverRow[],
  direction: Direction,
): SupportScore {
  const opposite = OPPOSITE_DIRECTION[direction];

  let support_score = 0;
  let contra_score  = 0;
  let primary_count = 0;

  for (const driver of drivers) {
    if (driver.direction === 'NEUTRAL') continue;
    const role = driver.role ?? (DRIVER_ROLES[driver.cardType] ?? 'CONTEXT');
    if (role === 'RISK') continue;

    const weight = TIER_WEIGHTS[driver.tier];

    if (driver.direction === direction) {
      support_score += weight;
      if (role === 'PRIMARY') primary_count++;
    } else if (opposite && driver.direction === opposite) {
      contra_score += weight;
    }
  }

  const net_support    = support_score - contra_score;
  const conflict_ratio = contra_score / Math.max(support_score, 0.01);

  const support_grade: SupportGrade =
    net_support >= GATE.FIRE_NET_SUPPORT && conflict_ratio < GATE.FIRE_CONFLICT_MAX
      ? 'STRONG'
      : net_support >= GATE.WATCH_NET_SUPPORT && conflict_ratio < GATE.WATCH_CONFLICT_MAX
        ? 'MIXED'
        : 'WEAK';

  return {
    support_score,
    contra_score,
    net_support,
    conflict_ratio,
    primary_count,
    support_grade,
  };
}
