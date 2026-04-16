/**
 * market-signals.ts
 *
 * Pure function for deriving market signal pills from a GameCard.
 * All logic is null-safe — returns [] when splits data is absent.
 *
 * Pill mapping (per WI-0775):
 *  Sharp Divergence  (blue)  — primary_reason_code PASS_SHARP_MONEY_OPPOSITE  OR  FADE_PUBLIC_POSITIVE in tags
 *  Public Heavy (X%) (amber) — recommended-side publicBetsPct > 65
 *  Contrarian Edge   (green) — FADE_PUBLIC_POSITIVE in tags  AND  recommended-side publicBetsPct < 40
 *  Consensus         (slate) — spreadConsensusConfidence === 'HIGH'  AND  no sharp divergence signal
 */

import type { GameCard } from '@/lib/types';

export type MarketSignalPillColor = 'blue' | 'amber' | 'green' | 'slate' | 'emerald';

export interface MarketSignalPill {
  label: string;
  color: MarketSignalPillColor;
}

/**
 * Derive market signal pills from a GameCard.
 *
 * Returns an empty array when:
 *  - `card.marketSignals` is absent
 *  - `card.marketSignals.splitsSource` is null (no live splits data yet)
 *
 * This guarantees no visual change on cards that pre-date WI-0666/0667 completion.
 */
export function deriveMarketSignals(card: GameCard): MarketSignalPill[] {
  const signals = card.marketSignals;

  // Guard: no splits data present → render nothing
  if (!signals || signals.splitsSource === null) return [];

  const pills: MarketSignalPill[] = [];
  const play = card.play;

  // ── Determine which side was recommended ──────────────────────────────────
  const direction = (
    play?.decision_v2?.direction ??
    play?.selection?.side ??
    play?.side ??
    ''
  ).toUpperCase();
  const isAway = direction === 'AWAY';
  const publicBetsPct = isAway
    ? signals.publicBetsPctAway
    : signals.publicBetsPctHome;

  // ── Signal flags ──────────────────────────────────────────────────────────
  const tags: string[] = (play?.tags as string[] | undefined) ?? [];
  const hasFadePublicPositive = tags.includes('FADE_PUBLIC_POSITIVE');

  const hasSharpDivergence =
    tags.includes('SHARP_MONEY_OPPOSITE') ||
    hasFadePublicPositive;

  // ── Pills ─────────────────────────────────────────────────────────────────

  // Sharp Divergence (blue)
  if (hasSharpDivergence) {
    pills.push({ label: 'Sharp Divergence', color: 'blue' });
  }

  // Sharp Aligned (emerald) — Circa agrees with our pick; suppressed if divergence also present
  if (tags.includes('SHARP_ALIGNED') && !hasSharpDivergence) {
    pills.push({ label: 'Sharp Aligned', color: 'emerald' });
  }

  // Public Heavy (amber) — show when > 65 % of bets on the recommended side
  if (typeof publicBetsPct === 'number' && publicBetsPct > 65) {
    pills.push({
      label: `Public Heavy (${Math.round(publicBetsPct)}%)`,
      color: 'amber',
    });
  }

  // Contrarian Edge (green) — fade signal + low public % on our side
  if (
    hasFadePublicPositive &&
    typeof publicBetsPct === 'number' &&
    publicBetsPct < 40
  ) {
    pills.push({ label: 'Contrarian Edge', color: 'green' });
  }

  // Consensus (slate) — high book consensus, no divergence signal
  if (
    !hasSharpDivergence &&
    signals.spreadConsensusConfidence === 'HIGH'
  ) {
    pills.push({ label: 'Consensus', color: 'slate' });
  }

  return pills;
}
