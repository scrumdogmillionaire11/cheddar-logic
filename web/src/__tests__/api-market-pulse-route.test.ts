import assert from 'node:assert/strict';
import { buildMarketPulsePayload } from '../lib/market-pulse/observability';
import type { LineGap, OddsGap, OddsSnapshot } from '../lib/types/market-pulse';

const NOW_MS = Date.parse('2026-05-05T16:00:00.000Z');

function test(name: string, fn: () => void): void {
  try {
    fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}`);
    throw error;
  }
}

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

function buildFixtures(): {
  snapshots: OddsSnapshot[];
  lineGaps: LineGap[];
  oddsGaps: OddsGap[];
} {
  return {
    snapshots: [
      buildSnapshot('composite', 'NBA', '2026-05-05T15:55:00.000Z', {
        spreads: [
          { book: 'FanDuel', home: -3.5, away: 3.5, price_home: -105, price_away: -115 },
          { book: 'DraftKings', home: -2.5, away: 2.5, price_home: -115, price_away: -105 },
          { book: 'BetMGM', home: -3.5, away: 3.5, price_home: -120, price_away: 100 },
        ],
      }),
      buildSnapshot('watch', 'MLB', '2026-05-05T15:30:00.000Z', { h2h: [] }),
      buildSnapshot('unsupported', 'MLB', '2026-05-05T15:45:00.000Z', { spreads: [] }),
      buildSnapshot('expired', 'MLB', '2026-05-05T14:20:00.000Z', { h2h: [] }),
    ],
    lineGaps: [
      {
        gameId: 'composite',
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
        capturedAt: '2026-05-05T15:55:00.000Z',
      },
    ],
    oddsGaps: [
      {
        gameId: 'composite',
        sport: 'NBA',
        homeTeam: 'Home',
        awayTeam: 'Away',
        market: 'spread',
        line: -3.5,
        side: 'home',
        bestBook: 'FanDuel',
        bestPrice: 100,
        worstBook: 'BetMGM',
        worstPrice: -120,
        impliedEdgePct: 0.032,
        tier: 'TRIGGER',
        capturedAt: '2026-05-05T15:55:00.000Z',
      },
      {
        gameId: 'watch',
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
        impliedEdgePct: 0.011,
        tier: 'WATCH',
        capturedAt: '2026-05-05T15:30:00.000Z',
      },
      {
        gameId: 'unsupported',
        sport: 'MLB',
        homeTeam: 'Home',
        awayTeam: 'Away',
        market: 'spread',
        line: -1.5,
        side: 'home',
        bestBook: 'FanDuel',
        bestPrice: 100,
        worstBook: 'BetMGM',
        worstPrice: -120,
        impliedEdgePct: 0.02,
        tier: 'TRIGGER',
        capturedAt: '2026-05-05T15:45:00.000Z',
      },
      {
        gameId: 'expired',
        sport: 'MLB',
        homeTeam: 'Home',
        awayTeam: 'Away',
        market: 'moneyline',
        line: null,
        side: 'home',
        bestBook: 'FanDuel',
        bestPrice: 102,
        worstBook: 'BetMGM',
        worstPrice: -118,
        impliedEdgePct: 0.031,
        tier: 'TRIGGER',
        capturedAt: '2026-05-05T14:20:00.000Z',
      },
    ],
  };
}

function run(): void {
  test('returns the full market-pulse response shape with numeric observability fields', () => {
    const payload = buildMarketPulsePayload({
      ...buildFixtures(),
      includeWatch: true,
      nowMs: NOW_MS,
      readers: {
        getLatestMlbModelOutput: () => ({ modelWinProbHome: 0.58, side: 'HOME' }),
        getLatestNbaModelOutput: () => ({ totalProjection: 221.2 }),
      },
    });

    assert.equal(typeof payload.scannedAt, 'string');
    assert.ok(Array.isArray(payload.opportunities));

    const requiredNumericFields = [
      'gamesScanned',
      'booksScanned',
      'rawLineGaps',
      'rawOddsGaps',
      'surfaced',
      'droppedDuplicate',
      'droppedStale',
      'droppedUnsupported',
      'droppedConflict',
      'freshCount',
      'staleVerifyRequiredCount',
      'expiredCount',
      'projectionAlignedWatchCount',
      'marketOnlyCount',
      'durationMs',
    ] as const;

    for (const field of requiredNumericFields) {
      assert.equal(typeof payload.meta[field], 'number', `${field} must be numeric`);
    }
  });

  test('includeWatch=false filters WATCH cards without mutating meta counters', () => {
    const fixtures = buildFixtures();
    const fullPayload = buildMarketPulsePayload({
      ...fixtures,
      includeWatch: true,
      nowMs: NOW_MS,
      readers: {
        getLatestMlbModelOutput: () => ({ modelWinProbHome: 0.58, side: 'HOME' }),
        getLatestNbaModelOutput: () => ({ totalProjection: 221.2 }),
      },
    });
    const filteredPayload = buildMarketPulsePayload({
      ...fixtures,
      includeWatch: false,
      nowMs: NOW_MS,
      readers: {
        getLatestMlbModelOutput: () => ({ modelWinProbHome: 0.58, side: 'HOME' }),
        getLatestNbaModelOutput: () => ({ totalProjection: 221.2 }),
      },
    });

    assert.equal(fullPayload.meta.surfaced, filteredPayload.meta.surfaced);
    assert.ok(fullPayload.opportunities.length > filteredPayload.opportunities.length);
    assert.equal(
      filteredPayload.opportunities.some((opportunity) => opportunity.displayTier === 'WATCH'),
      false,
    );
  });

  test('does not fabricate projection values for unsupported joins', () => {
    const payload = buildMarketPulsePayload({
      ...buildFixtures(),
      includeWatch: true,
      nowMs: NOW_MS,
      readers: {
        getLatestMlbModelOutput: () => ({ modelWinProbHome: 0.58, side: 'HOME' }),
        getLatestNbaModelOutput: () => ({ totalProjection: 221.2 }),
      },
    });

    const unsupported = payload.opportunities.find(
      (opportunity) => opportunity.gameId === 'unsupported',
    );

    assert.equal(unsupported?.projectionStatus, 'UNSUPPORTED_SPORT');
    assert.equal(unsupported?.projectionValue, undefined);
    assert.equal(unsupported?.fairPrice, undefined);
  });

  test('counts composite merges and expired opportunities in meta', () => {
    const payload = buildMarketPulsePayload({
      ...buildFixtures(),
      includeWatch: true,
      nowMs: NOW_MS,
      readers: {
        getLatestMlbModelOutput: () => ({ modelWinProbHome: 0.58, side: 'HOME' }),
        getLatestNbaModelOutput: () => ({ totalProjection: 221.2 }),
      },
    });

    assert.equal(payload.meta.droppedDuplicate, 1);
    assert.equal(payload.meta.expiredCount, 1);
    assert.ok(
      payload.opportunities.some(
        (opportunity) => opportunity.gameId === 'expired' && opportunity.displayTier === 'EXPIRED',
      ),
    );
  });
}

run();
