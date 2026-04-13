/*
 * Behavioral hardening tests for latest game-line and player-props transform paths.
 * Run: cd web && node --import tsx/esm src/__tests__/game-card-transform-hardening.test.js
 */

import assert from 'node:assert';
import {
  transformToGameCard,
  transformPropGames,
} from '../lib/game-card/transform/index.ts';

console.log('🧪 Game-line + player-props hardening transform tests');

function makeBaseGame(overrides = {}) {
  return {
    id: 'game-hardening-base',
    gameId: 'game-hardening-base',
    sport: 'NHL',
    homeTeam: 'Carolina Hurricanes',
    awayTeam: 'New York Rangers',
    gameTimeUtc: '2026-04-14T23:00:00Z',
    status: 'scheduled',
    createdAt: '2026-04-13T20:00:00Z',
    projection_inputs_complete: true,
    projection_missing_inputs: [],
    source_mapping_ok: true,
    source_mapping_failures: [],
    ingest_failure_reason_code: null,
    ingest_failure_reason_detail: null,
    odds: {
      h2hHome: -120,
      h2hAway: 110,
      total: 5.5,
      spreadHome: null,
      spreadAway: null,
      spreadPriceHome: null,
      spreadPriceAway: null,
      totalPriceOver: -110,
      totalPriceUnder: -110,
      capturedAt: '2026-04-13T20:05:00Z',
    },
    consistency: { total_bias: 'OK' },
    true_play: null,
    plays: [],
    ...overrides,
  };
}

function makeNhlTotalsPlay(status, action = 'HOLD') {
  return {
    source_card_id: `card-nhl-totals-${status.toLowerCase().replace(/\s+/g, '-')}`,
    cardType: 'nhl-totals-call',
    cardTitle: 'NHL Totals Call: OVER',
    prediction: 'OVER',
    confidence: 0.66,
    tier: 'BEST',
    reasoning: 'Model projects 6.2 vs market 5.5 with stable pace context.',
    evPassed: true,
    driverKey: 'nhl-totals-call',
    projectedTotal: 6.2,
    edge: 0.06,
    p_fair: 0.56,
    p_implied: 0.5,
    model_prob: 0.56,
    kind: 'PLAY',
    market_type: 'TOTAL',
    selection: { side: 'OVER' },
    line: 5.5,
    price: -110,
    status: action === 'FIRE' ? 'FIRE' : action === 'HOLD' ? 'WATCH' : 'PASS',
    classification: action === 'PASS' ? 'PASS' : 'BASE',
    action,
    pass_reason_code: action === 'PASS' ? 'PASS_NO_EDGE' : null,
    reason_codes: action === 'PASS' ? ['PASS_NO_EDGE'] : [],
    nhl_totals_status: { status },
  };
}

{
  const game = makeBaseGame({
    id: 'nhl-play-bucket',
    gameId: 'nhl-play-bucket',
    plays: [makeNhlTotalsPlay('PLAY', 'HOLD')],
  });

  const card = transformToGameCard(game);
  assert(card.play, 'NHL totals PLAY bucket should produce a card play');
  assert.strictEqual(
    card.play.decision,
    'FIRE',
    'NHL totals status PLAY should map to FIRE decision in cards transform',
  );
}

{
  const game = makeBaseGame({
    id: 'nhl-slight-edge-bucket',
    gameId: 'nhl-slight-edge-bucket',
    plays: [makeNhlTotalsPlay('SLIGHT EDGE', 'FIRE')],
  });

  const card = transformToGameCard(game);
  assert(card.play, 'NHL totals SLIGHT EDGE bucket should produce a card play');
  assert.strictEqual(
    card.play.decision,
    'WATCH',
    'NHL totals status SLIGHT EDGE should map to WATCH decision when not hard-pass',
  );
}

{
  const game = makeBaseGame({
    id: 'nhl-pass-bucket',
    gameId: 'nhl-pass-bucket',
    plays: [makeNhlTotalsPlay('PASS', 'FIRE')],
  });

  const card = transformToGameCard(game);
  assert(card.play, 'NHL totals PASS bucket should produce a card play');
  assert.strictEqual(
    card.play.decision,
    'PASS',
    'NHL totals status PASS should force PASS decision even when source action is FIRE',
  );
}

function makeBasePropGame(overrides = {}) {
  return makeBaseGame({
    id: 'props-hardening-base',
    gameId: 'props-hardening-base',
    sport: 'MLB',
    homeTeam: 'New York Mets',
    awayTeam: 'Los Angeles Dodgers',
    odds: {
      h2hHome: -115,
      h2hAway: 105,
      total: 8.0,
      spreadHome: null,
      spreadAway: null,
      spreadPriceHome: null,
      spreadPriceAway: null,
      totalPriceOver: -110,
      totalPriceUnder: -110,
      capturedAt: '2026-04-13T20:12:00Z',
    },
    ...overrides,
  });
}

{
  const propGame = makeBasePropGame({
    id: 'props-projection-only-keep',
    gameId: 'props-projection-only-keep',
    plays: [
      {
        source_card_id: 'card-mlb-k-projection-only',
        cardType: 'mlb-player-k',
        cardTitle: 'Pitcher Strikeouts: Spencer Strider OVER 6.5',
        prediction: 'OVER',
        confidence: 0.55,
        tier: 'WATCH',
        reasoning: 'Synthetic fallback projection only until market line firms.',
        evPassed: false,
        driverKey: 'pitcher-k',
        market_type: 'PROP',
        canonical_market_key: 'pitcher_strikeouts',
        selection: { side: 'OVER', team: 'Spencer Strider' },
        player_id: '555',
        player_name: 'Spencer Strider',
        line: 7,
        suggested_line: 6.5,
        action: 'FIRE',
        status: 'FIRE',
        basis: 'PROJECTION_ONLY',
        execution_status: 'PROJECTION_ONLY',
        prop_display_state: 'PLAY',
        prop_decision: {
          verdict: 'PASS',
          projection_source: 'SYNTHETIC_FALLBACK',
          line: 6.5,
          k_mean: 7.1,
          status_cap: null,
        },
      },
    ],
  });

  const cards = transformPropGames([propGame]);
  assert.strictEqual(cards.length, 1, 'props transform should keep projection-only rows in props surface');
  const row = cards[0]?.propPlays?.[0];
  assert(row, 'projection-only row should be emitted as a prop row');
  assert.strictEqual(row.propVerdict, 'PROJECTION', 'projection-only rows should normalize to PROJECTION verdict');
  assert.strictEqual(row.status, 'NO_PLAY', 'projection-only rows should be non-actionable in props surface');
  assert.strictEqual(row.marketLine, 6.5, 'props transform should prefer prop_decision.line over play.line');
  assert.strictEqual(row.projection, 7.1, 'props transform should prefer prop_decision.k_mean as canonical projection');
}

{
  const duplicateRowsGame = makeBasePropGame({
    id: 'props-no-play-dedupe-priority',
    gameId: 'props-no-play-dedupe-priority',
    plays: [
      {
        source_card_id: 'card-mlb-k-no-play-gap-small',
        cardType: 'mlb-player-k',
        cardTitle: 'Pitcher Strikeouts: Max Fried OVER 6.5',
        prediction: 'OVER',
        confidence: 0.7,
        tier: 'WATCH',
        reasoning: 'Near threshold, no-play.',
        evPassed: false,
        driverKey: 'pitcher-k',
        market_type: 'PROP',
        canonical_market_key: 'pitcher_strikeouts',
        selection: { side: 'OVER', team: 'Max Fried' },
        player_id: '777',
        player_name: 'Max Fried',
        line: 6.5,
        suggested_line: 6.5,
        status: 'PASS',
        action: 'PASS',
        prop_decision: {
          verdict: 'PASS',
          line: 6.5,
          projection: 6.2,
          line_delta: -0.3,
          prob_edge_pp: 0.4,
        },
      },
      {
        source_card_id: 'card-mlb-k-no-play-gap-large',
        cardType: 'mlb-player-k',
        cardTitle: 'Pitcher Strikeouts: Max Fried OVER 6.5',
        prediction: 'OVER',
        confidence: 0.65,
        tier: 'WATCH',
        reasoning: 'Larger miss to threshold, still no-play.',
        evPassed: false,
        driverKey: 'pitcher-k',
        market_type: 'PROP',
        canonical_market_key: 'pitcher_strikeouts',
        selection: { side: 'OVER', team: 'Max Fried' },
        player_id: '777',
        player_name: 'Max Fried',
        line: 6.5,
        suggested_line: 6.5,
        status: 'PASS',
        action: 'PASS',
        prop_decision: {
          verdict: 'PASS',
          line: 6.5,
          projection: 5.1,
          line_delta: -1.4,
          prob_edge_pp: 0.1,
        },
      },
    ],
  });

  const cards = transformPropGames([duplicateRowsGame]);
  const propRows = cards[0]?.propPlays ?? [];
  assert.strictEqual(propRows.length, 1, 'duplicate player+prop rows should dedupe to one display row');
  assert.strictEqual(
    propRows[0].lineDelta,
    -1.4,
    'no-play dedupe should keep the stronger no-play gap after verdict-based sorting',
  );
}

console.log('✅ Game-line + player-props hardening transform tests passed');
