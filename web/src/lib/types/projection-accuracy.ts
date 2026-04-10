/**
 * projection-accuracy.ts — WI-0867
 *
 * TypeScript types for the /api/results/projection-accuracy route.
 * Data surface: proxy-line accuracy signal only (no picks, prices, or recommendations).
 */

export interface TierRecord {
  decisions: number;
  wins: number;
  losses: number;
  hit_rate: number | null;
}

export interface ProjectionFamilySummary {
  card_family: string;              // 'MLB_F5_TOTAL' | 'NHL_1P_TOTAL'
  game_date_range: { gte: string | null; lte: string | null };
  total_games: number;
  total_proxy_decisions: number;
  wins: number;
  losses: number;
  no_bets: number;
  proxy_hit_rate: number | null;    // wins / (wins + losses)
  consensus_games: number;
  consensus_wins: number;
  consensus_hit_rate: number | null;
  split_zone_games: number;
  avg_tier_score: number | null;
  total_score: number;
  by_tier: {
    LEAN:   TierRecord;
    PLAY:   TierRecord;
    STRONG: TierRecord;
  };
  by_proxy_line: Record<string, TierRecord>;  // keyed by '1.5', '3.5', '4.5', etc.
}

export interface ProjectionAccuracyResponse {
  generatedAt: string;              // ISO timestamp
  lookbackDays: number;
  families: ProjectionFamilySummary[];
}
