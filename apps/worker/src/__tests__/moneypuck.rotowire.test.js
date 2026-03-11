const {
  enrichOddsSnapshotWithMoneyPuck,
  normalizeRotowireGoalieStatus,
  resolveRotowireGoalieForGame,
} = require('../moneypuck');

describe('moneypuck rotowire goalie enrichment', () => {
  test('preserves semantic distinction: CONFIRMED (locked) vs EXPECTED (projected) vs UNKNOWN', () => {
    // CONFIRMED = official game-day roster (never downgrade)
    expect(normalizeRotowireGoalieStatus('confirmed')).toBe('CONFIRMED');
    
    // EXPECTED/PROJECTED/LIKELY = still being projected, not yet official (subject to change)
    expect(normalizeRotowireGoalieStatus('expected')).toBe('EXPECTED');
    expect(normalizeRotowireGoalieStatus('projected')).toBe('EXPECTED');
    expect(normalizeRotowireGoalieStatus('likely')).toBe('EXPECTED');
    
    // UNKNOWN = uncertain/unconfirmed
    expect(normalizeRotowireGoalieStatus('unknown')).toBe('UNKNOWN');
    expect(normalizeRotowireGoalieStatus('unconfirmed')).toBe('UNKNOWN');
    expect(normalizeRotowireGoalieStatus('')).toBe(null);
  });

  test('selects date-specific rotowire goalie instead of merged team fallback', () => {
    const snapshot = {
      rotowire_goalies: {
        'Montreal Canadiens': {
          name: 'Wrong Confirmed Goalie',
            status: 'EXPECTED',
        },
      },
      rotowire_goalies_by_date: {
        '2026-03-11': {
          'Montreal Canadiens': {
            name: 'Jakub Dobes',
            status: 'EXPECTED',
          },
        },
      },
    };

    expect(
      resolveRotowireGoalieForGame(
        snapshot,
        'Montreal Canadiens',
        '2026-03-11T23:30:00Z',
      ),
    ).toEqual({
      name: 'Jakub Dobes',
      status: 'EXPECTED',
    });
  });

  test('enrichment uses game-date goalie names and statuses', async () => {
    const enriched = await enrichOddsSnapshotWithMoneyPuck(
      {
        home_team: 'OTTAWA SENATORS',
        away_team: 'MONTREAL CANADIENS',
        game_time_utc: '2026-03-11T23:30:00Z',
        raw_data: JSON.stringify({}),
      },
      {
        snapshot: {
          teams: {},
          goalies: {},
          injuries: {},
          rotowire_goalies: {
            'Montreal Canadiens': {
              name: 'Wrong Confirmed Goalie',
              status: 'CONFIRMED',
            },
            'Ottawa Senators': {
              name: 'Wrong Confirmed Home',
              status: 'EXPECTED',
            },
          },
          rotowire_goalies_by_date: {
            '2026-03-11': {
              'Montreal Canadiens': {
                name: 'Jakub Dobes',
                status: 'EXPECTED',
              },
              'Ottawa Senators': {
                name: 'Linus Ullmark',
                status: 'EXPECTED',
              },
            },
          },
        },
      },
    );

    const raw = JSON.parse(enriched.raw_data);
    expect(raw.goalie.away.name).toBe('Jakub Dobes');
    expect(raw.goalie.away.status).toBe('EXPECTED');
    expect(raw.goalie.home.name).toBe('Linus Ullmark');
    expect(raw.goalie.home.status).toBe('EXPECTED');
  });
});