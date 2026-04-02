'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  loadFixturesForSport,
  validateFixtureSchema,
} = require('../fixture_loader');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'fixture-loader-test-'));
}

function writeFixture(root, sport, fileName, data) {
  const dir = path.join(root, sport.toLowerCase());
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, fileName), JSON.stringify(data, null, 2), 'utf8');
}

/**
 * Minimal valid single-card fixture defaults. All required fields present.
 * Callers spread overrides on top.
 */
function validNbaFixture(overrides = {}) {
  return {
    fixture_id: 'nba_total_clean_01',
    sport: 'NBA',
    card_family: 'NBA_TOTAL',
    card_mode: 'ODDS_BACKED',
    input_contract: 'ODDS_SNAPSHOT',
    match_key: { game_id: 'nba_game_001', market_type: 'TOTAL', selection: 'OVER' },
    input: {
      game_id: 'nba_game_001',
      total_price_over: -110,
      total_price_under: -110,
    },
    expected: { input_hash: 'RECOMPUTE_ON_FIRST_RUN', execution_status: 'EXECUTABLE' },
    baseline_reviewed: false,
    ...overrides,
  };
}

function validMlbFixture(overrides = {}) {
  return {
    fixture_id: 'mlb_pitcher_k_clean_01',
    sport: 'MLB',
    card_family: 'MLB_PITCHER_K',
    card_mode: 'PROJECTION_ONLY',
    input_contract: 'ODDS_SNAPSHOT',
    match_key: { game_id: 'mlb_game_001', market_type: 'PITCHER_K', selection: 'OVER' },
    input: { game_id: 'mlb_game_001' },
    expected: { input_hash: 'RECOMPUTE_ON_FIRST_RUN', execution_status: 'PROJECTION_ONLY' },
    baseline_reviewed: false,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Schema validation — required fields
// ---------------------------------------------------------------------------

describe('validateFixtureSchema — required fields', () => {
  test('valid ODDS_BACKED fixture passes', () => {
    const result = validateFixtureSchema(validNbaFixture());
    expect(result.fixture_id).toBe('nba_total_clean_01');
    expect(result.card_family).toBe('NBA_TOTAL');
    expect(result.card_mode).toBe('ODDS_BACKED');
    expect(result.sport).toBe('NBA');
  });

  test('valid PROJECTION_ONLY fixture passes', () => {
    const result = validateFixtureSchema(validMlbFixture());
    expect(result.card_mode).toBe('PROJECTION_ONLY');
  });

  test('missing card_family fails hard — not a silent skip', () => {
    const fixture = validNbaFixture();
    delete fixture.card_family;
    expect(() => validateFixtureSchema(fixture)).toThrow(/"card_family"/);
  });

  test('missing card_mode fails hard', () => {
    const fixture = validNbaFixture();
    delete fixture.card_mode;
    expect(() => validateFixtureSchema(fixture)).toThrow(/"card_mode"/);
  });

  test('unknown card_mode fails hard', () => {
    const fixture = validNbaFixture({ card_mode: 'SPORT_ONLY' });
    expect(() => validateFixtureSchema(fixture)).toThrow(/card_mode/);
  });

  test('missing match_key fails hard', () => {
    const fixture = validNbaFixture();
    delete fixture.match_key;
    expect(() => validateFixtureSchema(fixture)).toThrow(/"match_key"/);
  });

  test('missing match_key.game_id fails hard', () => {
    const fixture = validNbaFixture({
      match_key: { market_type: 'TOTAL', selection: 'OVER' },
    });
    expect(() => validateFixtureSchema(fixture)).toThrow(/match_key\.game_id/);
  });

  test('missing fixture_id fails hard', () => {
    const fixture = validNbaFixture();
    delete fixture.fixture_id;
    expect(() => validateFixtureSchema(fixture)).toThrow(/"fixture_id"/);
  });

  test('missing input.game_id fails hard', () => {
    const fixture = validNbaFixture({ input: { total_price_over: -110, total_price_under: -110 } });
    expect(() => validateFixtureSchema(fixture)).toThrow(/input\.game_id/);
  });
});

// ---------------------------------------------------------------------------
// ODDS_BACKED vs PROJECTION_ONLY price rules
// ---------------------------------------------------------------------------

describe('validateFixtureSchema — card_mode price rules', () => {
  test('ODDS_BACKED fixture that omits price fields fails validation', () => {
    const fixture = validNbaFixture({
      input: { game_id: 'nba_game_001' }, // no price fields
    });
    expect(() => validateFixtureSchema(fixture)).toThrow(/ODDS_BACKED.*no price/i);
  });

  test('PROJECTION_ONLY fixture without price fields passes validation', () => {
    const fixture = validMlbFixture({
      input: { game_id: 'mlb_game_001' }, // no price fields — allowed
    });
    expect(() => validateFixtureSchema(fixture)).not.toThrow();
  });

  test('ODDS_BACKED with h2h prices satisfies price requirement', () => {
    const fixture = validNbaFixture({
      input: { game_id: 'nba_game_001', h2h_home: -145, h2h_away: 125 },
    });
    expect(() => validateFixtureSchema(fixture)).not.toThrow();
  });

  test('ODDS_BACKED with spread prices satisfies price requirement', () => {
    const fixture = validNbaFixture({
      input: {
        game_id: 'nba_game_001',
        spread_price_home: -110,
        spread_price_away: -110,
      },
    });
    expect(() => validateFixtureSchema(fixture)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// MLB guard
// ---------------------------------------------------------------------------

describe('validateFixtureSchema — MLB scope guard', () => {
  test('MLB fixture with PROJECTION_ONLY passes', () => {
    expect(() => validateFixtureSchema(validMlbFixture())).not.toThrow();
  });

  test('MLB fixture with ODDS_BACKED fails — executable MLB not in current scope', () => {
    const fixture = {
      fixture_id: 'mlb_bad_01',
      sport: 'MLB',
      card_family: 'MLB_F5_TOTAL',
      card_mode: 'ODDS_BACKED',
      input_contract: 'ODDS_SNAPSHOT',
      match_key: { game_id: 'mlb_bad_game', market_type: 'F5_TOTAL', selection: 'UNDER' },
      input: { game_id: 'mlb_bad_game', total_price_over: -110, total_price_under: -110 },
      expected: { input_hash: 'RECOMPUTE_ON_FIRST_RUN' },
      baseline_reviewed: false,
    };
    expect(() => validateFixtureSchema(fixture)).toThrow(/MLB.*PROJECTION_ONLY/i);
  });
});

// ---------------------------------------------------------------------------
// baseline_reviewed guard
// ---------------------------------------------------------------------------

describe('validateFixtureSchema — baseline_reviewed guard', () => {
  test('baseline_reviewed=false with RECOMPUTE hash passes', () => {
    const fixture = validNbaFixture({ baseline_reviewed: false });
    expect(() => validateFixtureSchema(fixture)).not.toThrow();
  });

  test('baseline_reviewed=true with real hash passes', () => {
    const fixture = validNbaFixture({
      baseline_reviewed: true,
      expected: { input_hash: 'abc123deadbeef', execution_status: 'EXECUTABLE' },
    });
    expect(() => validateFixtureSchema(fixture)).not.toThrow();
  });

  test('baseline_reviewed=true with RECOMPUTE_ON_FIRST_RUN hash fails hard', () => {
    const fixture = validNbaFixture({
      baseline_reviewed: true,
      expected: { input_hash: 'RECOMPUTE_ON_FIRST_RUN', execution_status: 'EXECUTABLE' },
    });
    expect(() => validateFixtureSchema(fixture)).toThrow(/baseline_reviewed.*true/i);
  });
});

// ---------------------------------------------------------------------------
// Multi-card (MIXED) validation
// ---------------------------------------------------------------------------

describe('validateFixtureSchema — MIXED multi-card', () => {
  function validMixedFixture(subCardOverrides = []) {
    const subCards = subCardOverrides.length > 0
      ? subCardOverrides
      : [
          {
            card_family: 'NHL_TOTAL',
            card_mode: 'ODDS_BACKED',
            match_key: { game_id: 'nhl_multi_001', market_type: 'TOTAL', selection: 'UNDER' },
            input: { game_id: 'nhl_multi_001', total_price_over: -110, total_price_under: -110 },
            expected: { input_hash: 'RECOMPUTE_ON_FIRST_RUN' },
          },
          {
            card_family: 'NHL_1P_TOTAL',
            card_mode: 'PROJECTION_ONLY',
            match_key: { game_id: 'nhl_multi_001', market_type: '1P_TOTAL', selection: 'UNDER' },
            input: { game_id: 'nhl_multi_001' },
            expected: { input_hash: 'RECOMPUTE_ON_FIRST_RUN' },
          },
          {
            card_family: 'NHL_PLAYER_SHOTS',
            card_mode: 'PROJECTION_ONLY',
            match_key: { game_id: 'nhl_multi_001', market_type: 'PLAYER_SHOTS', selection: 'OVER' },
            input: { game_id: 'nhl_multi_001' },
            expected: { input_hash: 'RECOMPUTE_ON_FIRST_RUN' },
          },
        ];
    return {
      fixture_id: 'nhl_multi_001',
      sport: 'NHL',
      card_family: 'MIXED',
      card_mode: 'MIXED',
      input_contract: 'ODDS_SNAPSHOT',
      match_key: { game_id: 'nhl_multi_001', market_type: 'MULTI', selection: 'ALL' },
      input: { game_id: 'nhl_multi_001' },
      expected: { input_hash: 'RECOMPUTE_ON_FIRST_RUN', sub_card_count: subCards.length },
      sub_cards: subCards,
      baseline_reviewed: false,
    };
  }

  test('valid MIXED fixture with 3 sub-cards passes', () => {
    const fixture = validMixedFixture();
    const result = validateFixtureSchema(fixture);
    expect(result.card_mode).toBe('MIXED');
    expect(result.sub_cards).toHaveLength(3);
  });

  test('MIXED fixture loads as a single fixture with 3 distinct sub-cards', () => {
    const fixture = validMixedFixture();
    const result = validateFixtureSchema(fixture);
    const marketTypes = result.sub_cards.map((sc) => sc.match_key.market_type);
    expect(new Set(marketTypes).size).toBe(3);
  });

  test('multi-card fixture: all sub-cards carry distinct match_key.market_type values', () => {
    const fixture = validMixedFixture();
    const marketTypes = fixture.sub_cards.map((sc) => sc.match_key.market_type);
    const duplicates = marketTypes.filter((t, i) => marketTypes.indexOf(t) !== i);
    expect(duplicates).toHaveLength(0);
  });

  test('MIXED with duplicate sub-card market_type fails hard', () => {
    const fixture = validMixedFixture();
    // make two sub-cards share the same market_type
    fixture.sub_cards[1].match_key.market_type = 'TOTAL';
    expect(() => validateFixtureSchema(fixture)).toThrow(/distinct.*market_type/i);
  });

  test('MIXED with fewer than 2 sub-cards fails hard', () => {
    const fixture = validMixedFixture();
    fixture.sub_cards = fixture.sub_cards.slice(0, 1);
    expect(() => validateFixtureSchema(fixture)).toThrow(/at least 2/i);
  });

  test('MIXED sub-card missing card_family fails hard', () => {
    const fixture = validMixedFixture();
    delete fixture.sub_cards[0].card_family;
    expect(() => validateFixtureSchema(fixture)).toThrow(/"card_family"/);
  });

  test('MIXED sub-card missing match_key fails hard', () => {
    const fixture = validMixedFixture();
    delete fixture.sub_cards[0].match_key;
    expect(() => validateFixtureSchema(fixture)).toThrow(/"match_key"/);
  });

  test('MIXED ODDS_BACKED sub-card without price fields fails hard', () => {
    const fixture = validMixedFixture();
    // remove price fields from the ODDS_BACKED sub-card
    fixture.sub_cards[0].input = { game_id: 'nhl_multi_001' };
    expect(() => validateFixtureSchema(fixture)).toThrow(/ODDS_BACKED.*no price/i);
  });

  test('Malformed MIXED with card_mode=ODDS_BACKED but no price throws, not silently continues', () => {
    const badOddsBackedSubCard = {
      card_family: 'NHL_TOTAL',
      card_mode: 'ODDS_BACKED',
      match_key: { game_id: 'nhl_multi_001', market_type: 'TOTAL', selection: 'UNDER' },
      input: { game_id: 'nhl_multi_001' }, // no price fields — should throw
      expected: { input_hash: 'RECOMPUTE_ON_FIRST_RUN' },
    };
    const fixture = validMixedFixture();
    fixture.sub_cards[0] = badOddsBackedSubCard;
    expect(() => validateFixtureSchema(fixture)).toThrow();
  });
});

// ---------------------------------------------------------------------------
// loadFixturesForSport — counts
// ---------------------------------------------------------------------------

describe('loadFixturesForSport — fixture counts', () => {
  test('returns correct count for NBA (5 fixtures)', () => {
    // Writes the 5 NBA fixtures into a temp dir and checks count
    const root = makeTempRoot();
    for (let i = 1; i <= 5; i++) {
      writeFixture(root, 'NBA', 'nba_fixture_0' + i + '.json', {
        fixture_id: 'nba_fixture_0' + i,
        sport: 'NBA',
        card_family: 'NBA_TOTAL',
        card_mode: 'ODDS_BACKED',
        input_contract: 'ODDS_SNAPSHOT',
        match_key: { game_id: 'nba_game_0' + i, market_type: 'TOTAL', selection: 'OVER' },
        input: { game_id: 'nba_game_0' + i, total_price_over: -110, total_price_under: -110 },
        expected: { input_hash: 'RECOMPUTE_ON_FIRST_RUN' },
        baseline_reviewed: false,
      });
    }
    const fixtures = loadFixturesForSport('NBA', { fixturesRoot: root });
    expect(fixtures).toHaveLength(5);
  });

  test('returns correct count for NHL (7 fixtures)', () => {
    const root = makeTempRoot();
    for (let i = 1; i <= 7; i++) {
      writeFixture(root, 'NHL', 'nhl_fixture_0' + i + '.json', {
        fixture_id: 'nhl_fixture_0' + i,
        sport: 'NHL',
        card_family: 'NHL_TOTAL',
        card_mode: 'ODDS_BACKED',
        input_contract: 'ODDS_SNAPSHOT',
        match_key: { game_id: 'nhl_game_0' + i, market_type: 'TOTAL', selection: 'UNDER' },
        input: { game_id: 'nhl_game_0' + i, total_price_over: -115, total_price_under: -105 },
        expected: { input_hash: 'RECOMPUTE_ON_FIRST_RUN' },
        baseline_reviewed: false,
      });
    }
    const fixtures = loadFixturesForSport('NHL', { fixturesRoot: root });
    expect(fixtures).toHaveLength(7);
  });

  test('returns correct count for MLB (6 fixtures)', () => {
    const root = makeTempRoot();
    for (let i = 1; i <= 6; i++) {
      writeFixture(root, 'MLB', 'mlb_fixture_0' + i + '.json', {
        fixture_id: 'mlb_fixture_0' + i,
        sport: 'MLB',
        card_family: 'MLB_PITCHER_K',
        card_mode: 'PROJECTION_ONLY',
        input_contract: 'ODDS_SNAPSHOT',
        match_key: { game_id: 'mlb_game_0' + i, market_type: 'PITCHER_K', selection: 'OVER' },
        input: { game_id: 'mlb_game_0' + i },
        expected: { input_hash: 'RECOMPUTE_ON_FIRST_RUN' },
        baseline_reviewed: false,
      });
    }
    const fixtures = loadFixturesForSport('MLB', { fixturesRoot: root });
    expect(fixtures).toHaveLength(6);
  });

  test('loadFixturesForSport returns normalized card_family from each fixture', () => {
    const root = makeTempRoot();
    writeFixture(root, 'NHL', 'nhl_a.json', validNbaFixture({
      fixture_id: 'nhl_a',
      sport: 'NHL',
      card_family: 'NHL_TOTAL',
      match_key: { game_id: 'nhl_a_game', market_type: 'TOTAL', selection: 'UNDER' },
      input: { game_id: 'nhl_a_game', total_price_over: -110, total_price_under: -110 },
    }));
    const [fixture] = loadFixturesForSport('NHL', { fixturesRoot: root });
    expect(fixture.card_family).toBe('NHL_TOTAL');
    expect(fixture.card_mode).toBe('ODDS_BACKED');
  });
});

// ---------------------------------------------------------------------------
// Failure modes — guards
// ---------------------------------------------------------------------------

describe('failure mode guards', () => {
  test('fixture using sport only (no card_family) fails — not routed silently', () => {
    const fixture = validNbaFixture();
    delete fixture.card_family;
    expect(() => validateFixtureSchema(fixture)).toThrow(/"card_family"/);
  });

  test('fixture with card_mode=ODDS_BACKED and no line inputs throws, not silently continues', () => {
    const fixture = validNbaFixture({
      input: { game_id: 'nba_game_001' }, // no price fields
    });
    expect(() => validateFixtureSchema(fixture)).toThrow();
  });

  test('baseline_reviewed=true with RECOMPUTE hash is rejected — cannot auto-promote baseline', () => {
    const fixture = validNbaFixture({
      baseline_reviewed: true,
      expected: { input_hash: 'RECOMPUTE_ON_FIRST_RUN' },
    });
    expect(() => validateFixtureSchema(fixture)).toThrow(/baseline_reviewed/i);
  });

  test('MLB executable game card (ODDS_BACKED) is rejected at schema level', () => {
    const fixture = {
      fixture_id: 'mlb_exec_01',
      sport: 'MLB',
      card_family: 'MLB_F5_TOTAL',
      card_mode: 'ODDS_BACKED',
      input_contract: 'ODDS_SNAPSHOT',
      match_key: { game_id: 'mlb_exec_game', market_type: 'F5_TOTAL', selection: 'UNDER' },
      input: { game_id: 'mlb_exec_game', total_price_over: -110, total_price_under: -110 },
      expected: { input_hash: 'RECOMPUTE_ON_FIRST_RUN' },
      baseline_reviewed: false,
    };
    expect(() => validateFixtureSchema(fixture)).toThrow(/MLB.*PROJECTION_ONLY/i);
  });

  test('MIXED fixture without match_key on sub-card throws, not silently drops card', () => {
    const fixture = {
      fixture_id: 'nhl_multi_bad',
      sport: 'NHL',
      card_family: 'MIXED',
      card_mode: 'MIXED',
      input_contract: 'ODDS_SNAPSHOT',
      match_key: { game_id: 'nhl_multi_bad_game', market_type: 'MULTI', selection: 'ALL' },
      input: { game_id: 'nhl_multi_bad_game' },
      expected: {},
      sub_cards: [
        {
          card_family: 'NHL_TOTAL',
          card_mode: 'ODDS_BACKED',
          // match_key deliberately omitted
          input: { game_id: 'nhl_multi_bad_game', total_price_over: -110, total_price_under: -110 },
          expected: {},
        },
        {
          card_family: 'NHL_1P_TOTAL',
          card_mode: 'PROJECTION_ONLY',
          match_key: { game_id: 'nhl_multi_bad_game', market_type: '1P_TOTAL', selection: 'UNDER' },
          input: { game_id: 'nhl_multi_bad_game' },
          expected: {},
        },
      ],
      baseline_reviewed: false,
    };
    expect(() => validateFixtureSchema(fixture)).toThrow(/"match_key"/);
  });
});
