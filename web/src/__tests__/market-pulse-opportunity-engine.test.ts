import assert from 'node:assert/strict';
import {
  buildMarketPulseView,
  type ProjectionReaders,
} from '../lib/market-pulse/opportunity-engine';
import type { LineGap, OddsGap, OddsSnapshot } from '../lib/types/market-pulse';

const NOW_MS = Date.parse('2026-05-05T16:00:00.000Z');

function buildSnapshot(
  gameId: string,
  sport: string,
  capturedAt: string,
  markets: Record<string, unknown>,
): OddsSnapshot {
  return {
    game_id: gameId,
    sport,
    captured_at: capturedAt,
    raw_data: JSON.stringify({ markets }),
  };
}

function buildSpreadLineGap(overrides: Partial<LineGap> = {}): LineGap {
  return {
    gameId: 'game-spread',
    sport: 'NBA',
    homeTeam: 'Home',
    awayTeam: 'Away',
    market: 'spread',
    outlierBook: 'FanDuel',
    outlierLine: -3.5,
    consensusLine: -2.5,
    delta: 1,
    direction: 'home',
    tier: 'TRIGGER',
    capturedAt: '2026-05-05T15:50:00.000Z',
    ...overrides,
  };
}

function buildOddsGap(overrides: Partial<OddsGap> = {}): OddsGap {
  return {
    gameId: 'game-odds',
    sport: 'MLB',
    homeTeam: 'Home',
    awayTeam: 'Away',
    market: 'moneyline',
    line: null,
    side: 'home',
    bestBook: 'FanDuel',
    bestPrice: 105,
    worstBook: 'BetMGM',
    worstPrice: -115,
    impliedEdgePct: 0.032,
    tier: 'TRIGGER',
    capturedAt: '2026-05-05T15:55:00.000Z',
    ...overrides,
  };
}

function test(name: string, fn: () => void): void {
  try {
    fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}`);
    throw error;
  }
}

function run(): void {
  test('enriches line-gap cards with snapshot price and reference book data', () => {
    const snapshot = buildSnapshot('game-spread', 'NBA', '2026-05-05T15:50:00.000Z', {
      spreads: [
        { book: 'FanDuel', home: -3.5, away: 3.5, price_home: -105, price_away: -115 },
        { book: 'DraftKings', home: -2.5, away: 2.5, price_home: -115, price_away: -105 },
        { book: 'Caesars', home: -2.5, away: 2.5, price_home: -110, price_away: -110 },
      ],
    });

    const result = buildMarketPulseView({
      snapshots: [snapshot],
      lineGaps: [buildSpreadLineGap()],
      oddsGaps: [],
      nowMs: NOW_MS,
    });

    assert.equal(result.opportunities.length, 1);
    const opportunity = result.opportunities[0];
    assert.equal(opportunity.bestBook, 'FanDuel');
    assert.equal(opportunity.bestPrice, -105);
    assert.equal(opportunity.referenceBook, 'DraftKings');
    assert.equal(opportunity.referencePrice, -115);
    assert.deepEqual(opportunity.signalKinds, ['LINE']);
    assert.equal(opportunity.lineDelta, 1);
  });

  test('merges same-cluster line and price signals into one composite card', () => {
    const snapshot = buildSnapshot('game-spread', 'NBA', '2026-05-05T15:50:00.000Z', {
      spreads: [
        { book: 'FanDuel', home: -3.5, away: 3.5, price_home: -105, price_away: -115 },
        { book: 'DraftKings', home: -2.5, away: 2.5, price_home: -115, price_away: -105 },
        { book: 'BetMGM', home: -3.5, away: 3.5, price_home: -120, price_away: 100 },
      ],
    });
    const oddsGap = buildOddsGap({
      gameId: 'game-spread',
      sport: 'NBA',
      market: 'spread',
      line: -3.5,
      side: 'home',
      bestBook: 'FanDuel',
      bestPrice: 100,
      worstBook: 'BetMGM',
      worstPrice: -120,
    });

    const result = buildMarketPulseView({
      snapshots: [snapshot],
      lineGaps: [buildSpreadLineGap()],
      oddsGaps: [oddsGap],
      nowMs: NOW_MS,
    });

    assert.equal(result.opportunities.length, 1);
    assert.equal(result.counters.droppedDuplicate, 1);
    const opportunity = result.opportunities[0];
    assert.deepEqual(opportunity.signalKinds, ['LINE', 'PRICE']);
    assert.equal(opportunity.bestBook, 'FanDuel');
    assert.equal(opportunity.bestPrice, 100);
    assert.equal(opportunity.referenceBook, 'BetMGM');
    assert.equal(opportunity.referencePrice, -120);
    assert.equal(opportunity.suppressionReason, 'MERGED_COMPOSITE_SIGNAL');
  });

  test('supports MLB, NBA, and NHL projection overlays while leaving unsupported markets market-only', () => {
    const readers: ProjectionReaders = {
      getLatestMlbModelOutput: () => ({ modelWinProbHome: 0.58, side: 'HOME' }),
      getLatestNbaModelOutput: () => ({ totalProjection: 221.3 }),
      getLatestNhlModelOutput: () => ({
        model_signal: {
          market_type: 'MONEYLINE',
          selection_side: 'HOME',
          model_prob: 0.56,
          fair_price: -127,
        },
      }),
    };

    const snapshots = [
      buildSnapshot('mlb-1', 'MLB', '2026-05-05T15:55:00.000Z', { h2h: [] }),
      buildSnapshot('nba-1', 'NBA', '2026-05-05T15:55:00.000Z', { totals: [] }),
      buildSnapshot('nhl-1', 'NHL', '2026-05-05T15:55:00.000Z', { h2h: [] }),
      buildSnapshot('mlb-unsupported', 'MLB', '2026-05-05T15:55:00.000Z', { spreads: [] }),
    ];

    const oddsGaps: OddsGap[] = [
      buildOddsGap({ gameId: 'mlb-1', sport: 'MLB', market: 'moneyline', side: 'home' }),
      buildOddsGap({
        gameId: 'nba-1',
        sport: 'NBA',
        market: 'total',
        line: 218.5,
        side: 'over',
      }),
      buildOddsGap({
        gameId: 'nhl-1',
        sport: 'NHL',
        market: 'moneyline',
        side: 'home',
      }),
      buildOddsGap({
        gameId: 'mlb-unsupported',
        sport: 'MLB',
        market: 'spread',
        line: -1.5,
        side: 'home',
      }),
    ];

    const result = buildMarketPulseView({
      snapshots,
      lineGaps: [],
      oddsGaps,
      nowMs: NOW_MS,
      readers,
    });

    const byGameId = new Map(result.opportunities.map((opportunity) => [opportunity.gameId, opportunity]));

    assert.equal(byGameId.get('mlb-1')?.projectionStatus, 'CONFIRMED');
    assert.equal(byGameId.get('mlb-1')?.opportunityKind, 'PROJECTION_CONFIRMED');
    assert.equal(byGameId.get('nba-1')?.projectionStatus, 'CONFIRMED');
    assert.equal(byGameId.get('nba-1')?.projectionValue, 221.3);
    assert.equal(byGameId.get('nhl-1')?.projectionStatus, 'CONFIRMED');
    assert.equal(byGameId.get('nhl-1')?.fairPrice, -127);
    assert.equal(byGameId.get('mlb-unsupported')?.projectionStatus, 'UNSUPPORTED_SPORT');
    assert.equal(byGameId.get('mlb-unsupported')?.displayTier, 'MARKET_ONLY');
    assert.equal(byGameId.get('mlb-unsupported')?.projectionValue, undefined);
  });

  test('marks opposite-side model signals as conflicting and never scout', () => {
    const result = buildMarketPulseView({
      snapshots: [
        buildSnapshot('mlb-mismatch', 'MLB', '2026-05-05T15:55:00.000Z', { h2h: [] }),
      ],
      lineGaps: [],
      oddsGaps: [
        buildOddsGap({
          gameId: 'mlb-mismatch',
          sport: 'MLB',
          market: 'moneyline',
          side: 'away',
        }),
      ],
      nowMs: NOW_MS,
      readers: {
        getLatestMlbModelOutput: () => ({ modelWinProbHome: 0.6, side: 'HOME' }),
      },
    });

    const opportunity = result.opportunities[0];
    assert.equal(opportunity.projectionStatus, 'MISMATCHED');
    assert.equal(opportunity.opportunityKind, 'CONFLICTING');
    assert.equal(opportunity.displayTier, 'WATCH');
  });

  test('enforces freshness-tier rules and verify-before-bet copy', () => {
    const result = buildMarketPulseView({
      snapshots: [
        buildSnapshot('fresh', 'MLB', '2026-05-05T15:55:00.000Z', { h2h: [] }),
        buildSnapshot('stale', 'MLB', '2026-05-05T15:20:00.000Z', { h2h: [] }),
        buildSnapshot('expired', 'MLB', '2026-05-05T14:30:00.000Z', { h2h: [] }),
      ],
      lineGaps: [],
      oddsGaps: [
        buildOddsGap({ gameId: 'fresh', capturedAt: '2026-05-05T15:55:00.000Z' }),
        buildOddsGap({ gameId: 'stale', capturedAt: '2026-05-05T15:20:00.000Z' }),
        buildOddsGap({ gameId: 'expired', capturedAt: '2026-05-05T14:30:00.000Z' }),
      ],
      nowMs: NOW_MS,
      readers: {
        getLatestMlbModelOutput: () => ({ modelWinProbHome: 0.57, side: 'HOME' }),
      },
    });

    const byGameId = new Map(result.opportunities.map((opportunity) => [opportunity.gameId, opportunity]));

    assert.equal(byGameId.get('fresh')?.freshnessStatus, 'FRESH');
    assert.equal(byGameId.get('fresh')?.displayTier, 'SCOUT');
    assert.equal(byGameId.get('fresh')?.verifyBeforeBetLabel, null);

    assert.equal(byGameId.get('stale')?.freshnessStatus, 'STALE_VERIFY_REQUIRED');
    assert.equal(byGameId.get('stale')?.displayTier, 'WATCH');
    assert.equal(
      byGameId.get('stale')?.verifyBeforeBetLabel,
      'Verify before betting — odds may be stale',
    );

    assert.equal(byGameId.get('expired')?.freshnessStatus, 'EXPIRED');
    assert.equal(byGameId.get('expired')?.displayTier, 'EXPIRED');
    assert.equal(
      byGameId.get('expired')?.verifyBeforeBetLabel,
      'Verify before betting — odds may be stale',
    );
  });

  test('opportunity ids are deterministic for identical inputs', () => {
    const snapshots = [
      buildSnapshot('deterministic', 'MLB', '2026-05-05T15:55:00.000Z', { h2h: [] }),
    ];
    const oddsGaps = [
      buildOddsGap({
        gameId: 'deterministic',
        sport: 'MLB',
      }),
    ];

    const first = buildMarketPulseView({
      snapshots,
      lineGaps: [],
      oddsGaps,
      nowMs: NOW_MS,
    });
    const second = buildMarketPulseView({
      snapshots,
      lineGaps: [],
      oddsGaps,
      nowMs: NOW_MS,
    });

    assert.equal(first.opportunities[0]?.opportunityId, second.opportunities[0]?.opportunityId);
  });
}

run();
