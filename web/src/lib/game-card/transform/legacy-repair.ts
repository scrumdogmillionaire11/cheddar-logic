/**
 * Sport card type contract helpers, play/evidence classification, and legacy source helpers
 * Extracted from game-card/transform.ts (WI-0622)
 */

import type { ApiPlay } from './index';
import type { ExpressionStatus } from '../../types';
import { resolvePlayDisplayDecision } from '../decision';
import { getSportCardTypeContract as getSharedSportCardTypeContract } from '../../games/market-inference';
import { isWelcomeHomeCardType } from '../welcome-home';

export function normalizeCardType(cardType: string): string {
  return cardType.trim().toLowerCase();
}

export function getSportCardTypeContract(
  sport?: unknown,
):
  | { playProducerCardTypes: Set<string>; evidenceOnlyCardTypes: Set<string> }
  | undefined {
  if (!sport) return undefined;
  return getSharedSportCardTypeContract(sport);
}

export function isPlayItem(play: ApiPlay, sport?: string): boolean {
  const contract = getSportCardTypeContract(sport);
  const cardType = normalizeCardType(play.cardType || '');
  const kind = play.kind ?? 'PLAY';
  if (contract) {
    if (contract.evidenceOnlyCardTypes.has(cardType)) return false;
    if (kind === 'PLAY' && !contract.playProducerCardTypes.has(cardType)) {
      return false;
    }
  }
  return kind === 'PLAY';
}

export function isEvidenceItem(play: ApiPlay, sport?: string): boolean {
  const contract = getSportCardTypeContract(sport);
  const cardType = normalizeCardType(play.cardType || '');
  if (contract?.evidenceOnlyCardTypes.has(cardType)) {
    return true;
  }
  if (contract && !contract.playProducerCardTypes.has(cardType)) {
    return true;
  }
  return (play.kind ?? 'PLAY') === 'EVIDENCE';
}

export function isWelcomeHomePlay(play: ApiPlay): boolean {
  return isWelcomeHomeCardType(play.cardType);
}

export function getSourcePlayAction(
  play?: ApiPlay,
): 'FIRE' | 'HOLD' | 'PASS' | undefined {
  if (!play) return undefined;
  const legacyStatus = String(play.status ?? '').toUpperCase();
  const hasExplicitAction =
    play.action === 'FIRE' || play.action === 'HOLD' || play.action === 'PASS';
  const hasClassification =
    play.classification === 'BASE' ||
    play.classification === 'LEAN' ||
    play.classification === 'PASS';
  const normalizedLegacyStatus: ExpressionStatus | undefined =
    legacyStatus === 'FIRE'
      ? 'FIRE'
      : legacyStatus === 'PASS'
        ? 'PASS'
        : legacyStatus === 'WATCH' || legacyStatus === 'HOLD'
          ? 'WATCH'
          : undefined;

  if (!hasExplicitAction && !hasClassification && !normalizedLegacyStatus) {
    return undefined;
  }

  return resolvePlayDisplayDecision({
    action: hasExplicitAction ? play.action : undefined,
    classification: hasClassification ? play.classification : undefined,
    status: normalizedLegacyStatus,
  }).action;
}

function _clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function _clamp01(value: number): number {
  return _clamp(value, 0, 1);
}

export function resolveSourceModelProb(play?: ApiPlay): number | undefined {
  const raw = play?.model_prob;
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return undefined;
  if (raw < 0 || raw > 1) return undefined;
  return _clamp01(raw);
}
