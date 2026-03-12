const {
  enrichOddsSnapshotWithMoneyPuck,
  normalizeRotowireGoalieStatus,
  resolveRotowireGoalieForGameDetailed,
  resolveRotowireGoalieForGame,
} = require('../moneypuck');

describe('moneypuck rotowire goalie enrichment', () => {
  test('preserves semantic distinction: CONFIRMED (locked) vs EXPECTED (projected) vs UNKNOWN', () => {
    // CONFIRMED = official game-day roster (never downgrade)
    expect(normalizeRotowireGoalieStatus('confirmed')).toBe('CONFIRMED');
    expect(normalizeRotowireGoalieStatus('starting')).toBe('CONFIRMED');
    expect(normalizeRotowireGoalieStatus('official')).toBe('CONFIRMED');
    
    // EXPECTED/PROJECTED/LIKELY = still being projected, not yet official (subject to change)
    expect(normalizeRotowireGoalieStatus('expected')).toBe('EXPECTED');
    expect(normalizeRotowireGoalieStatus('projected')).toBe('EXPECTED');
    expect(normalizeRotowireGoalieStatus('likely')).toBe('EXPECTED');
    
    // UNKNOWN = uncertain/unconfirmed
    expect(normalizeRotowireGoalieStatus('unknown')).toBe('UNKNOWN');
    expect(normalizeRotowireGoalieStatus('unconfirmed')).toBe('UNKNOWN');
    expect(normalizeRotowireGoalieStatus('')).toBe(null);
  });

  test('resolves previous-day ET fallback when exact date key misses', () => {
    const snapshot = {
      rotowire_goalies: {},
      rotowire_goalies_by_date: {
        '2026-03-11': {
          'Montreal Canadiens': {
            name: 'Jakub Dobes',
            status: 'CONFIRMED',
          },
        },
      },
    };

    const resolved = resolveRotowireGoalieForGameDetailed(
      snapshot,
      'Montreal Canadiens',
      '2026-03-12T01:10:00Z',
    );

    expect(resolved.goalie).toEqual({
      name: 'Jakub Dobes',
      status: 'CONFIRMED',
    });
    expect(resolved.diagnostics.primary_date_key).toBe('2026-03-11');
    expect(resolved.diagnostics.resolution_path).toBe('DATE_EXACT');
    expect(resolved.diagnostics.raw_source_date_key_used).toBe('2026-03-11');
  });

  test('emits explicit source miss markers when Rotowire data is unavailable', async () => {
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
          rotowire_goalies: {},
          rotowire_goalies_by_date: {},
        },
      },
    );

    const raw = JSON.parse(enriched.raw_data);
    expect(raw.goalie.home.source_markers).toEqual(
      expect.arrayContaining([
        'ROTOWIRE_DATE_WINDOW_MISS',
        'ROTOWIRE_SOURCE_MISS',
      ]),
    );
    expect(raw.goalie.away.source_markers).toEqual(
      expect.arrayContaining([
        'ROTOWIRE_DATE_WINDOW_MISS',
        'ROTOWIRE_SOURCE_MISS',
      ]),
    );
  });

  test('keeps CONFIRMED certainty when status is explicit even with null GSaX', async () => {
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
              name: 'Jakub Dobes',
              status: 'CONFIRMED',
            },
            'Ottawa Senators': {
              name: 'Linus Ullmark',
              status: 'CONFIRMED',
            },
          },
          rotowire_goalies_by_date: {
            '2026-03-11': {
              'Montreal Canadiens': {
                name: 'Jakub Dobes',
                status: 'CONFIRMED',
              },
              'Ottawa Senators': {
                name: 'Linus Ullmark',
                status: 'CONFIRMED',
              },
            },
          },
        },
      },
    );

    const raw = JSON.parse(enriched.raw_data);
    expect(raw.goalie.home.gsax).toBeNull();
    expect(raw.goalie.away.gsax).toBeNull();
    expect(raw.goalie.home.status).toBe('CONFIRMED');
    expect(raw.goalie.away.status).toBe('CONFIRMED');
    expect(raw.goalie_home_status).toBe('CONFIRMED');
    expect(raw.goalie_away_status).toBe('CONFIRMED');
  });

  test('does not silently downgrade existing certainty on Rotowire source miss', async () => {
    const enriched = await enrichOddsSnapshotWithMoneyPuck(
      {
        home_team: 'OTTAWA SENATORS',
        away_team: 'MONTREAL CANADIENS',
        game_time_utc: '2026-03-11T23:30:00Z',
        raw_data: JSON.stringify({
          goalie_home_status: 'CONFIRMED',
          goalie_away_status: 'EXPECTED',
          goalie: {
            home: { status: 'CONFIRMED' },
            away: { status: 'EXPECTED' },
          },
        }),
      },
      {
        snapshot: {
          teams: {},
          goalies: {},
          injuries: {},
          rotowire_goalies: {},
          rotowire_goalies_by_date: {},
        },
      },
    );

    const raw = JSON.parse(enriched.raw_data);
    expect(raw.goalie_home_status).toBe('CONFIRMED');
    expect(raw.goalie_away_status).toBe('EXPECTED');
    expect(raw.goalie.home.source_markers).toEqual(
      expect.arrayContaining([
        'ROTOWIRE_DATE_WINDOW_MISS',
        'ROTOWIRE_SOURCE_MISS',
      ]),
    );
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