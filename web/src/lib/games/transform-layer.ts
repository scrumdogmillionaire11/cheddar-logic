import {
  isCanonicalTotalsCallPlay,
  isFallbackEvidenceTotalProjectionPlay,
} from '@/lib/games/market-inference';
import type { Play } from './route-handler';

const TOTAL_PROJECTION_DRIFT_WARN_THRESHOLD = 0.5;

export function emitTotalProjectionDriftWarnings(
  games: Array<{ gameId: string; sport: string; plays: Play[] }>,
): void {
  if (process.env.NODE_ENV === 'test') return;
  for (const game of games) {
    const canonicalPlay = game.plays.find(isCanonicalTotalsCallPlay);
    const fallbackPlay = game.plays.find(isFallbackEvidenceTotalProjectionPlay);
    if (!canonicalPlay || !fallbackPlay) continue;

    const canonicalProjectedTotal = canonicalPlay.projectedTotal as number;
    const fallbackProjectedTotal = fallbackPlay.projectedTotal as number;
    const delta = Math.abs(canonicalProjectedTotal - fallbackProjectedTotal);
    if (delta <= TOTAL_PROJECTION_DRIFT_WARN_THRESHOLD) continue;

    console.warn('[API] /api/games total projection drift warning', {
      game_id: game.gameId,
      sport: game.sport,
      threshold: TOTAL_PROJECTION_DRIFT_WARN_THRESHOLD,
      delta: Number(delta.toFixed(2)),
      canonical: {
        card_type: canonicalPlay.cardType,
        projected_total: canonicalProjectedTotal,
      },
      fallback: {
        card_type: fallbackPlay.cardType,
        projected_total: fallbackProjectedTotal,
      },
    });
  }
}
