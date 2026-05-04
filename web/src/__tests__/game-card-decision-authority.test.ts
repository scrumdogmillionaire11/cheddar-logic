import assert from 'node:assert';

import { applyFilters, DEFAULT_GAME_FILTERS } from '../lib/game-card/filters';
import {
  getGameExclusionReason,
  transformGames,
  transformToGameCard,
} from '../lib/game-card/transform/index';

type OfficialStatus = 'PLAY' | 'LEAN' | 'PASS';
type ExecutionStatus = 'EXECUTABLE' | 'BLOCKED' | 'PROJECTION_ONLY';

function buildMoneylineGame(params: {
  sport: 'MLB' | 'NHL';
  officialStatus: OfficialStatus;
  executionStatus: ExecutionStatus;
}) {
  const play = {
    cardType: params.sport === 'NHL' ? 'nhl-moneyline-call' : 'mlb-full-game-ml',
    cardTitle: 'Model moneyline',
    prediction: 'HOME' as const,
    confidence: 0.72,
    tier: 'BEST' as const,
    reasoning: 'Moneyline edge.',
    evPassed: true,
    driverKey: `driver-${params.sport}-${params.executionStatus}`,
    edge: 0.06,
    model_prob: 0.56,
    market_type: 'MONEYLINE' as const,
    selection: { side: 'HOME' as const, team: 'Home Team' },
    kind: 'PLAY' as const,
    price: -110,
    status: 'WATCH' as const,
    classification: 'LEAN' as const,
    action: 'HOLD' as const,
    execution_status: params.executionStatus,
    pass_reason_code:
      params.executionStatus === 'BLOCKED'
        ? 'PASS_EXECUTION_GATE_BLOCKED'
        : params.executionStatus === 'PROJECTION_ONLY'
          ? 'PASS_PROJECTION_ONLY'
          : null,
    created_at: '2026-04-11T14:00:00.000Z',
    decision_v2: {
      official_status: params.officialStatus,
      direction: 'HOME' as const,
      fair_prob: 0.56,
      implied_prob: 0.52,
      edge_pct: 0.06,
      edge_delta_pct: 0.06,
      play_tier: 'OK' as const,
      support_score: 0.67,
      conflict_score: 0.12,
      drivers_used: ['projection'],
      driver_reasons: ['edge'],
      primary_reason_code: 'EDGE_CLEAR',
      watchdog_status: 'OK' as const,
      watchdog_reason_codes: [],
      sharp_price_status: 'CHEDDAR' as const,
      price_reason_codes: [],
      missing_data: { missing_fields: [], source_attempts: [], severity: 'INFO' as const },
      consistency: {
        pace_tier: 'NORMAL',
        event_env: 'NORMAL',
        event_direction_tag: 'NEUTRAL',
        vol_env: 'NORMAL',
        total_bias: 'OK',
      },
      pricing_trace: { line_source: 'odds_snapshot', price_source: 'odds_snapshot' },
      pipeline_version: 'v2' as const,
      decided_at: '2026-04-11T14:00:00.000Z',
    },
  };

  return {
    id: `game-${params.sport}-${params.executionStatus}`,
    gameId: `game-${params.sport}-${params.executionStatus}`,
    sport: params.sport,
    homeTeam: 'Home Team',
    awayTeam: 'Away Team',
    gameTimeUtc: '2026-04-11T19:00:00.000Z',
    status: 'scheduled',
    createdAt: '2026-04-11T14:00:00.000Z',
    odds: {
      h2hHome: -120,
      h2hAway: 105,
      total: 8.5,
      spreadHome: -1.5,
      spreadAway: 1.5,
      spreadPriceHome: -110,
      spreadPriceAway: -110,
      totalPriceOver: -110,
      totalPriceUnder: -110,
      capturedAt: '2026-04-11T14:05:00.000Z',
    },
    plays: [play],
    true_play: play,
  };
}

type TestGame = ReturnType<typeof buildMoneylineGame>;
type TestPlay = TestGame['plays'][number];

function buildDiagnosticInfoPlay(params: {
  sport: 'MLB' | 'NHL';
  officialStatus: OfficialStatus;
}): TestPlay {
  const basePlay = buildMoneylineGame({
    sport: params.sport,
    officialStatus: params.officialStatus,
    executionStatus: 'EXECUTABLE',
  }).plays[0] as TestPlay;

  return {
    ...basePlay,
    cardTitle: 'Diagnostic info',
    reasoning: 'Informational diagnostic only.',
    driverKey: `driver-${params.sport}-INFO`,
    market_type: 'INFO',
    action:
      params.officialStatus === 'PLAY'
        ? 'FIRE'
        : params.officialStatus === 'LEAN'
          ? 'HOLD'
          : 'PASS',
    classification:
      params.officialStatus === 'PLAY'
        ? 'BASE'
        : params.officialStatus === 'LEAN'
          ? 'LEAN'
          : 'PASS',
    decision_v2: {
      ...basePlay.decision_v2,
      official_status: params.officialStatus,
      direction: 'HOME',
    },
  };
}

function buildMixedInfoGame(sport: 'MLB' | 'NHL'): TestGame {
  const game = buildMoneylineGame({
    sport,
    officialStatus: 'LEAN',
    executionStatus: 'EXECUTABLE',
  });
  const playablePlay = game.plays[0] as TestPlay;
  const infoPlay = buildDiagnosticInfoPlay({ sport, officialStatus: 'PLAY' });

  return {
    ...game,
    id: `game-${sport}-mixed-info`,
    gameId: `game-${sport}-mixed-info`,
    plays: [infoPlay, playablePlay],
    true_play: infoPlay,
  };
}

function buildInfoOnlyGame(sport: 'MLB' | 'NHL'): TestGame {
  const game = buildMoneylineGame({
    sport,
    officialStatus: 'LEAN',
    executionStatus: 'EXECUTABLE',
  });
  const infoPlay = buildDiagnosticInfoPlay({ sport, officialStatus: 'LEAN' });

  return {
    ...game,
    id: `game-${sport}-info-only`,
    gameId: `game-${sport}-info-only`,
    plays: [infoPlay],
    true_play: infoPlay,
  };
}

for (const sport of ['MLB', 'NHL'] as const) {
  const executableCard = transformToGameCard(
    buildMoneylineGame({ sport, officialStatus: 'LEAN', executionStatus: 'EXECUTABLE' }) as never,
  );
  assert.strictEqual(executableCard.play?.action, 'HOLD');
  assert.strictEqual(applyFilters([executableCard], DEFAULT_GAME_FILTERS, 'game').length, 1);

  for (const blockedStatus of ['BLOCKED', 'PROJECTION_ONLY'] as const) {
    const blockedCard = transformToGameCard(
      buildMoneylineGame({ sport, officialStatus: 'LEAN', executionStatus: blockedStatus }) as never,
    );
    assert.strictEqual(applyFilters([blockedCard], DEFAULT_GAME_FILTERS, 'game').length, 0);
  }
}

{
  const game = buildMoneylineGame({
    sport: 'MLB',
    officialStatus: 'LEAN',
    executionStatus: 'EXECUTABLE',
  });
  const play = game.plays[0] as {
    prediction?: string;
    selection?: { side: string; team: string };
    decision_v2: {
      direction: string;
      canonical_envelope_v2?: Record<string, unknown>;
    };
  };
  play.prediction = 'AWAY';
  play.selection = { side: 'AWAY', team: 'Away Team' };
  play.decision_v2.direction = 'HOME';
  play.decision_v2.canonical_envelope_v2 = {
    official_status: 'LEAN',
    primary_reason_code: 'EDGE_CLEAR',
    direction: 'HOME',
    selection_side: 'HOME',
    selection_team: 'Home Team',
    reason_codes: ['EDGE_CLEAR'],
    terminal_reason_family: 'QUALIFIED',
    is_actionable: true,
    execution_status: 'EXECUTABLE',
    publish_ready: true,
  };

  const card = transformToGameCard(game as never);
  assert.strictEqual(card.play?.side, 'HOME');
  assert.strictEqual(card.play?.selection?.side, 'HOME');
  assert.strictEqual(card.play?.selection?.team, 'Home Team');
}

for (const sport of ['MLB', 'NHL'] as const) {
  const mixedGame = buildMixedInfoGame(sport);
  assert.strictEqual(getGameExclusionReason(mixedGame as never), null);

  const [card] = transformGames([mixedGame as never]);
  assert.ok(card, `${sport} mixed INFO fixture should remain on the main surface`);
  assert.strictEqual(card.play?.market_type, 'MONEYLINE');
  assert.strictEqual(card.play?.action, 'HOLD');
  assert.notStrictEqual(card.play?.market_type, 'INFO');
}

for (const sport of ['MLB', 'NHL'] as const) {
  const infoOnlyGame = buildInfoOnlyGame(sport);
  assert.strictEqual(getGameExclusionReason(infoOnlyGame as never), 'no-renderable-plays');
  assert.deepStrictEqual(transformGames([infoOnlyGame as never]), []);
}

console.log('Game card decision authority tests passed');
