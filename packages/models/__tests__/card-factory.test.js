'use strict';

const { buildMarketCallCard } = require('../src/card-factory');

describe('buildMarketCallCard — deterministic ID (WI-0812)', () => {
  const baseArgs = {
    sport: 'NBA',
    gameId: 'game-nba-2026-04-07-bos-mia',
    cardType: 'nba-totals-call',
    cardTitle: 'BOS vs MIA — Totals',
    payloadData: { recommended_bet_type: 'TOTAL', selection: { side: 'OVER' } },
    now: '2026-04-07T01:00:00.000Z',
    expiresAt: '2026-04-07T08:00:00.000Z',
  };

  it('produces the same id on two calls with identical args', () => {
    const card1 = buildMarketCallCard(baseArgs);
    const card2 = buildMarketCallCard(baseArgs);
    expect(card1.id).toBe(card2.id);
  });

  it('id format is card-<cardType>-<gameId>', () => {
    const card = buildMarketCallCard(baseArgs);
    expect(card.id).toBe(`card-${baseArgs.cardType}-${baseArgs.gameId}`);
  });

  it('different gameId values produce different ids', () => {
    const card1 = buildMarketCallCard({ ...baseArgs, gameId: 'game-nba-2026-04-07-bos-mia' });
    const card2 = buildMarketCallCard({ ...baseArgs, gameId: 'game-nba-2026-04-07-gsw-lac' });
    expect(card1.id).not.toBe(card2.id);
  });

  it('different cardType values produce different ids', () => {
    const card1 = buildMarketCallCard({ ...baseArgs, cardType: 'nba-totals-call' });
    const card2 = buildMarketCallCard({ ...baseArgs, cardType: 'nba-spread-call' });
    expect(card1.id).not.toBe(card2.id);
  });

  it('returns correct metadata fields', () => {
    const card = buildMarketCallCard(baseArgs);
    expect(card.gameId).toBe(baseArgs.gameId);
    expect(card.sport).toBe('NBA');
    expect(card.cardType).toBe(baseArgs.cardType);
    expect(card.cardTitle).toBe(baseArgs.cardTitle);
    expect(card.createdAt).toBe(baseArgs.now);
    expect(card.expiresAt).toBe(baseArgs.expiresAt);
    expect(card.payloadData).toEqual(baseArgs.payloadData);
  });

  it('sport is normalized to uppercase', () => {
    const card = buildMarketCallCard({ ...baseArgs, sport: 'nba' });
    expect(card.sport).toBe('NBA');
  });

  it('missing required params throws', () => {
    expect(() => buildMarketCallCard({ ...baseArgs, gameId: undefined })).toThrow();
    expect(() => buildMarketCallCard({ ...baseArgs, cardType: undefined })).toThrow();
    expect(() => buildMarketCallCard({ ...baseArgs, payloadData: undefined })).toThrow();
    expect(() => buildMarketCallCard({ ...baseArgs, now: undefined })).toThrow();
  });
});

describe('generateCard — UUID suffix import still present (driver cards out of scope)', () => {
  it('uuidV4 is still imported (used by generateCard driver cards)', () => {
    // generateCard at line 62 uses uuidV4 for driver card IDs.
    // We do NOT remove the import — this test confirms card-factory still loads.
    const factory = require('../src/card-factory');
    expect(typeof factory.generateCard).toBe('function');
    expect(typeof factory.buildMarketCallCard).toBe('function');
  });
});
