const {
  isNonPassCard,
  isDisplayableWebhookCard,
  isDisplayableWebhookCardLegacy,
  classifyDecisionBucket,
  classifyDecisionBucketLegacy,
  selectionSummary,
  passesLeanThreshold,
  buildDiscordSnapshot,
  chunkDiscordContent,
  sendDiscordMessages,
  postDiscordCards,
  decisionReason,
} = require('../post_discord_cards');
const { classifyNhlTotalsStatus } = require('../../models/nhl-totals-status');
const { computeWebhookFields } = require('../../utils/decision-publisher');
const fs = require('fs');
const Database = require('better-sqlite3');

/**
 * Simulate model-runner + publisher behaviour for NHL total card fixtures:
 * stamps nhl_totals_status then webhook_* fields, exactly as production does.
 * Uses |edge| with direction derived from selection.side so fixture edge values
 * can be either signed (UNDER uses negative) or unsigned (always positive).
 */
function stampNhlTotals(pd) {
  const reasonCodes = Array.from(
    new Set([
      ...(pd.reason_codes || []),
      ...(pd.blocked_reason_code ? [pd.blocked_reason_code] : []),
    ])
  );
  const integrityOk = !reasonCodes.includes('MIXED_BOOK_INTEGRITY_GATE');
  const goaliesConfirmed = !reasonCodes.includes('GOALIE_UNCONFIRMED');
  const edgeSign = pd.selection?.side === 'UNDER' ? -1 : 1;
  const absDelta = Math.abs(Number(pd.edge || 0));
  pd.sport = pd.sport || 'nhl';
  pd.nhl_totals_status = classifyNhlTotalsStatus({
    side: pd.selection?.side,
    modelTotal: Number(pd.line) + edgeSign * absDelta,
    marketTotal: Number(pd.line),
    integrityOk,
    goaliesConfirmedHome: goaliesConfirmed,
    goaliesConfirmedAway: goaliesConfirmed,
    majorInjuryUncertainty: reasonCodes.includes('MAJOR_INJURY_UNCERTAINTY'),
    accelerantScore: pd.accelerant_score ?? null,
    hasRequiredInputs: true,
  });
  computeWebhookFields(pd);
}

function makeCard(overrides = {}) {
  return {
    id: 'card-1',
    sport: 'nhl',
    matchup: 'Boston Bruins @ New York Rangers',
    cardType: 'nhl-model-output',
    payloadData: {
      action: 'FIRE',
      kind: 'PLAY',
      pass_reason: null,
      pass_reason_code: null,
      market_type: 'MONEYLINE',
      selection: { team: 'Boston Bruins' },
      price: -115,
      line: null,
      projection_only: false,
    },
    ...overrides,
  };
}

describe('post_discord_cards helpers', () => {
  test('isNonPassCard excludes PASS and includes non-PASS rows', () => {
    const passCard = makeCard({
      payloadData: {
        action: 'PASS',
        pass_reason: 'NO_EDGE',
      },
    });
    const projectionOnly = makeCard({
      payloadData: {
        action: 'WATCH',
        projection_only: true,
        pass_reason: null,
      },
    });

    expect(isNonPassCard(passCard)).toBe(false);
    expect(isNonPassCard(projectionOnly)).toBe(true);
  });

  test('isDisplayableWebhookCard keeps actionable PLAY feed rows and drops PASS variants', () => {
    const playCard = makeCard({
      payloadData: {
        action: 'FIRE',
        kind: 'PLAY',
        selection: { side: 'OVER' },
      },
    });
    const evidenceCard = makeCard({
      payloadData: {
        action: 'FIRE',
        kind: 'EVIDENCE',
        selection: null,
      },
    });
    const projectionOnly = makeCard({
      payloadData: {
        action: 'FIRE',
        kind: 'PLAY',
        projection_only: true,
        selection: { side: 'OVER' },
      },
    });
    const watchPlay = makeCard({
      payloadData: {
        action: 'HOLD',
        classification: 'LEAN',
        kind: 'PLAY',
        selection: { side: 'OVER' },
      },
    });
    const onePeriodPass = makeCard({
      payloadData: {
        action: 'WATCH',
        kind: 'PLAY',
        selection: { side: 'UNDER' },
        one_p_model_call: 'NHL_1P_PASS_DEAD_ZONE',
      },
    });
    const onePeriodPlayableEvidence = makeCard({
      cardType: 'nhl-pace-1p',
      payloadData: {
        action: 'WATCH',
        kind: 'EVIDENCE',
        period: '1P',
        one_p_model_call: 'NHL_1P_UNDER_PLAY',
        projection_only: false,
      },
    });
    const onePeriodHoldEvidence = makeCard({
      cardType: 'nhl-pace-1p',
      payloadData: {
        action: 'HOLD',
        status: 'WATCH',
        kind: 'EVIDENCE',
        period: '1P',
        projection_only: false,
      },
    });
    const passCard = makeCard({
      payloadData: {
        action: 'PASS',
        status: 'PASS',
        kind: 'EVIDENCE',
        selection: null,
      },
    });

    expect(isDisplayableWebhookCard(playCard)).toBe(true);
    expect(isDisplayableWebhookCard(evidenceCard)).toBe(false);
    expect(isDisplayableWebhookCard(projectionOnly)).toBe(false);
    expect(isDisplayableWebhookCard(watchPlay)).toBe(true);
    expect(isDisplayableWebhookCard(onePeriodPass)).toBe(true);
    expect(isDisplayableWebhookCard(onePeriodPlayableEvidence)).toBe(true);
    expect(isDisplayableWebhookCard(onePeriodHoldEvidence)).toBe(true);
    expect(isDisplayableWebhookCard(passCard)).toBe(true);
  });

  test('buildDiscordSnapshot creates one per-game message with official/lean/pass sections', () => {
    const cards = [
      makeCard({ id: 'core-1', cardType: 'nhl-model-output' }),
      makeCard({
        id: 'prop-1',
        cardType: 'nhl_player_shots_props',
        payloadData: {
          action: 'FIRE',
          kind: 'PLAY',
          market_type: 'PROP',
          selection: { team: 'Player A' },
          price: -120,
          pass_reason: null,
        },
      }),
      makeCard({
        id: 'pass-1',
        cardType: 'nhl-moneyline',
        payloadData: {
          action: 'PASS',
          kind: 'EVIDENCE',
          market_type: 'TOTAL',
          selection: null,
          pass_reason_code: 'PASS_NO_EDGE',
        },
      }),
    ];

    const snapshot = buildDiscordSnapshot({ cards, now: new Date('2026-03-20T14:00:00.000Z') });

    expect(snapshot.totalCards).toBe(3);
    expect(snapshot.totalGames).toBe(1);
    expect(snapshot.sectionCounts).toEqual({ official: 2, lean: 0, passBlocked: 1 });
    expect(snapshot.messages[0]).toContain('🟢 PLAY');
    // PASS block is suppressed when official plays are rendered — no contradiction
    expect(snapshot.messages[0]).not.toContain('⚪ PASS');
    // Internal reason codes must never appear in output
    expect(snapshot.messages[0]).not.toContain('PASS_NO_EDGE');
  });

  test('buildDiscordSnapshot skips games where nothing renders — only posts plays and leans', () => {
    const cards = [
      makeCard({
        id: 'pass-only',
        cardType: 'nhl-moneyline',
        payloadData: {
          action: 'PASS',
          kind: 'EVIDENCE',
          market_type: 'MONEYLINE',
          selection: null,
          pass_reason_code: 'PASS_NO_EDGE',
        },
      }),
      // Add a LEAN with sufficient edge so the game is posted
      makeCard({
        id: 'lean-1',
        cardType: 'nhl-model-output',
        payloadData: {
          action: 'LEAN',
          kind: 'PLAY',
          market_type: 'TOTAL',
          selection: { side: 'UNDER' },
          price: -115,
          line: 6.5,
          edge: 0.8,
          model_projection: 5.8,
          projection_only: false,
        },
      }),
    ];

    const snapshot = buildDiscordSnapshot({ cards, now: new Date('2026-03-20T14:00:00.000Z') });
    expect(snapshot.totalGames).toBe(1);
    // Lean rendered → PASS block suppressed
    expect(snapshot.messages[0]).toContain('🟡 Slight Edge');
    expect(snapshot.messages[0]).not.toContain('⚪ PASS');
  });

  test('buildDiscordSnapshot honors canonical webhook_bucket tokens even when uppercased', () => {
    const cards = [
      makeCard({
        id: 'canonical-upper-bucket',
        cardType: 'nhl-model-output',
        payloadData: {
          action: 'FIRE',
          kind: 'PLAY',
          market_type: 'TOTAL',
          selection: { side: 'OVER' },
          price: -110,
          line: 6.0,
          edge: 1.0,
          webhook_bucket: 'OFFICIAL',
          webhook_eligible: true,
        },
      }),
    ];

    const snapshot = buildDiscordSnapshot({ cards, now: new Date('2026-03-20T14:00:00.000Z') });
    expect(snapshot.sectionCounts.official).toBe(1);
    expect(snapshot.sectionCounts.lean).toBe(0);
    expect(snapshot.messages[0]).toContain('🟢 PLAY');
  });

  test('buildDiscordSnapshot renders header, PLAY section, and Slight Edge section in stable order', () => {
    const cards = [
      makeCard({
        id: 'official-layout',
        matchup: 'Washington Capitals @ Columbus Blue Jackets',
        gameTimeUtc: '2026-03-20T23:00:00.000Z',
        payloadData: {
          action: 'FIRE',
          kind: 'PLAY',
          market_type: 'MONEYLINE',
          selection: { side: 'HOME' },
          price: -115,
          why: 'Model edge confirmed at current number.',
          projection_only: false,
        },
      }),
      makeCard({
        id: 'lean-layout',
        matchup: 'Washington Capitals @ Columbus Blue Jackets',
        gameTimeUtc: '2026-03-20T23:00:00.000Z',
        cardType: 'nhl-totals-call',
        payloadData: {
          action: 'LEAN',
          kind: 'PLAY',
          market_type: 'TOTAL',
          selection: { side: 'UNDER' },
          line: 6.5,
          edge: 0.7,
          model_projection: 5.8,
          price: -108,
          why: 'Projection still favors the under, but not enough for PLAY.',
          projection_only: false,
        },
      }),
    ];

    const snapshot = buildDiscordSnapshot({ cards, now: new Date('2026-03-20T14:00:00.000Z') });
    const message = snapshot.messages[0];

    expect(snapshot.totalGames).toBe(1);
    expect(snapshot.sectionCounts).toEqual({ official: 1, lean: 1, passBlocked: 0 });
    expect(message).toContain('🏒 NHL | 7:00 PM ET');
    expect(message).toContain('WSH Capitals @ CBJ Blue Jackets');
    expect(message).toContain('As of: 10:00 AM ET');
    expect(message).toContain('🟢 PLAY');
    expect(message).toContain('ML | HOME (-115)');
    expect(message).toContain('Why: Model edge confirmed at current number.');
    expect(message).toContain('🟡 Slight Edge');
    expect(message).toContain('TOTAL | UNDER 6.5 (-108)');
    expect(message).toContain('5.8 | Edge: +0.70 (strong)');
    expect(message).toContain('Why: Projection still favors the under, but not enough for PLAY.');
    expect(message.indexOf('🟢 PLAY')).toBeLessThan(message.indexOf('🟡 Slight Edge'));
    expect(message).not.toContain('⚪ PASS');
  });

  test('buildDiscordSnapshot suppresses game where all bet calls are blocked and only EVIDENCE cards are FIRE', () => {
    // Regression: WSH@CBJ pattern where nhl-model-output / nhl-base-projection / nhl-rest-advantage /
    // nhl-goalie-certainty all had kind=EVIDENCE, action=FIRE, webhook_bucket='official', webhook_eligible=true
    // — causing a false 🟢 PLAY section when all real bet calls (nhl-moneyline-call, nhl-totals-call) were PASS.
    const gameTimeUtc = '2026-04-14T23:10:00.000Z';
    const cards = [
      // Real bet calls — all blocked
      makeCard({
        id: 'ml-blocked',
        matchup: 'Washington Capitals @ Columbus Blue Jackets',
        gameTimeUtc,
        cardType: 'nhl-moneyline-call',
        payloadData: {
          kind: 'PLAY',
          action: 'PASS',
          classification: 'PASS',
          webhook_bucket: 'pass_blocked',
          webhook_eligible: false,
          market_type: 'MONEYLINE',
          selection: { side: 'AWAY' },
          pass_reason_code: 'LINE_NOT_CONFIRMED',
        },
      }),
      // EVIDENCE context drivers — FIRE action but must not appear as bet rows
      makeCard({
        id: 'nhl-model-output-evidence',
        matchup: 'Washington Capitals @ Columbus Blue Jackets',
        gameTimeUtc,
        cardType: 'nhl-model-output',
        payloadData: {
          kind: 'EVIDENCE',
          action: 'FIRE',
          webhook_bucket: 'official',
          webhook_eligible: true,
          prediction: 'NEUTRAL',
          selection: null,
        },
      }),
      makeCard({
        id: 'nhl-base-proj-evidence',
        matchup: 'Washington Capitals @ Columbus Blue Jackets',
        gameTimeUtc,
        cardType: 'nhl-base-projection',
        payloadData: {
          kind: 'EVIDENCE',
          action: 'FIRE',
          webhook_bucket: 'official',
          webhook_eligible: true,
          prediction: 'AWAY',
          selection: null,
        },
      }),
      makeCard({
        id: 'nhl-rest-evidence',
        matchup: 'Washington Capitals @ Columbus Blue Jackets',
        gameTimeUtc,
        cardType: 'nhl-rest-advantage',
        payloadData: {
          kind: 'EVIDENCE',
          action: 'FIRE',
          webhook_bucket: 'official',
          webhook_eligible: true,
          prediction: 'NEUTRAL',
          selection: null,
        },
      }),
    ];

    const snapshot = buildDiscordSnapshot({ cards, now: new Date('2026-04-14T22:07:00.000Z') });

    // No PLAY or lean — game must be completely suppressed
    expect(snapshot.totalGames).toBe(0);
    expect(snapshot.messages).toHaveLength(0);
    expect(snapshot.sectionCounts.official).toBe(0);
    expect(snapshot.sectionCounts.lean).toBe(0);
  });

  test('buildDiscordSnapshot surfaces blocked high-signal passes as WATCH with explicit trigger', () => {
    const cards = [
      makeCard({
        id: 'blocked-play',
        matchup: 'Washington Capitals @ Columbus Blue Jackets',
        gameTimeUtc: '2026-03-20T23:00:00.000Z',
        payloadData: {
          action: 'PASS',
          status: 'PASS',
          kind: 'PLAY',
          market_type: 'MONEYLINE',
          selection: { side: 'HOME' },
          price: 100,
          edge: 0.21,
          pass_reason_code: 'LINE_NOT_CONFIRMED',
          projection_only: false,
          decision_v2: {
            play_tier: 'BEST',
          },
        },
      }),
    ];

    const snapshot = buildDiscordSnapshot({ cards, now: new Date('2026-03-20T14:00:00.000Z') });
    const message = snapshot.messages[0];

    expect(snapshot.totalGames).toBe(1);
    expect(snapshot.sectionCounts.passBlocked).toBe(1);
    expect(message).toContain('⚠️ WATCH — not a play yet');
    expect(message).toContain('ML | HOME (+100)');
    expect(message).toContain('Edge: +0.21 (strong)');
    expect(message).toContain('State: line not verified');
    expect(message).toContain('Would become PLAY: HOME if market verifies and edge >= +0.20 holds');
    expect(message).toContain('Recheck by: 6:30 PM ET (T-30m)');
    expect(message).toContain('Drops to PASS: edge < +0.20 or adverse market move');
    expect(message).toContain('Why: Line not confirmed');
    expect(message).not.toContain('⚪ PASS');
    expect(message).not.toContain('PASS_NO_EDGE');
  });

  test('buildDiscordSnapshot labels thin leans differently from strong leans', () => {
    const cards = [
      makeCard({
        id: 'thin-lean',
        matchup: 'Dallas Stars @ Toronto Maple Leafs',
        gameTimeUtc: '2026-03-20T23:00:00.000Z',
        cardType: 'nhl-totals-call',
        payloadData: {
          action: 'LEAN',
          kind: 'PLAY',
          market_type: 'TOTAL',
          selection: { side: 'UNDER' },
          line: 6.5,
          edge: 0.2,
          model_projection: 6.1,
          price: -108,
          projection_only: false,
        },
      }),
    ];

    const snapshot = buildDiscordSnapshot({ cards, now: new Date('2026-03-20T14:00:00.000Z') });

    expect(snapshot.totalGames).toBe(1);
    expect(snapshot.messages[0]).toContain('🟡 Slight Edge (Lean)');
    expect(snapshot.messages[0]).toContain('6.1 | Edge: +0.20 (strong)');
  });

  test('buildDiscordSnapshot normalizes MLB two-letter/variant teams in matchup header', () => {
    const cards = [
      makeCard({
        id: 'mlb-two-letter-variant',
        sport: 'mlb',
        matchup: 'CR @ Minnesota Twins',
        gameTimeUtc: '2026-04-17T00:11:00.000Z',
        cardType: 'mlb-moneyline-call',
        payloadData: {
          action: 'PASS',
          status: 'PASS',
          kind: 'PLAY',
          market_type: 'MONEYLINE',
          selection: { side: 'AWAY' },
          price: 146,
          edge: 0.05,
          pass_reason_code: 'LINE_NOT_CONFIRMED',
          decision_v2: { play_tier: 'BEST' },
          projection_only: false,
        },
      }),
    ];

    const snapshot = buildDiscordSnapshot({ cards, now: new Date('2026-04-17T14:30:00.000Z') });

    expect(snapshot.totalGames).toBe(1);
    expect(snapshot.messages[0]).toContain('CLE Guardians @ MIN Twins');
    expect(snapshot.messages[0]).toContain('⚠️ WATCH — not a play yet');
    expect(snapshot.messages[0]).toContain('State: line not verified');
    expect(snapshot.messages[0]).toContain('Would become PLAY: AWAY if market verifies and edge >= +0.05 holds');
    expect(snapshot.messages[0]).toContain('Recheck by: 7:41 PM ET (T-30m)');
    expect(snapshot.messages[0]).toContain('Drops to PASS: edge < +0.05 or adverse market move');
    expect(snapshot.messages[0]).toContain('Edge: +0.05');
  });

  test('buildDiscordSnapshot keeps 1P OVER/UNDER direction when selection object is empty', () => {
    const cards = [
      makeCard({
        id: 'pace-1p-empty-selection',
        sport: 'nhl',
        cardType: 'nhl-pace-1p',
        payloadData: {
          action: 'LEAN',
          kind: 'PLAY',
          market_type: 'TOTAL',
          period: '1P',
          selection: {},
          one_p_model_call: 'NHL_1P_OVER_PLAY',
          line: 1.5,
          edge: 0.7,
          model_projection: 2.0,
          price: -108,
          projection_only: false,
        },
      }),
    ];

    const snapshot = buildDiscordSnapshot({ cards, now: new Date('2026-03-20T14:00:00.000Z') });

    expect(snapshot.messages[0]).toContain('1P | OVER 1.5 (-108)');
    expect(snapshot.messages[0]).not.toContain('1P | 1.5');
  });

  test('buildDiscordSnapshot suppresses 1P cards with no direction — never posts 1P | 1.5', () => {
    const cards = [
      makeCard({
        id: 'pace-1p-no-direction',
        sport: 'nhl',
        cardType: 'nhl-pace-1p',
        matchup: 'Dallas Stars @ Toronto Maple Leafs',
        payloadData: {
          action: 'LEAN',
          kind: 'PLAY',
          market_type: 'FIRST_PERIOD',
          period: '1P',
          selection: null,
          prediction: 'LEAN', // no OVER/UNDER suffix
          market_context: { selection_side: null },
          pricing_trace: { called_side: null },
          line: 1.5,
          edge: 0.5,
          model_projection: 1.9,
          price: -108,
          projection_only: false,
        },
      }),
    ];

    const snapshot = buildDiscordSnapshot({ cards, now: new Date('2026-03-20T14:00:00.000Z') });

    // Card with no direction must not post — not even as a lean
    expect(snapshot.totalGames).toBe(0);
    expect(snapshot.messages).toHaveLength(0);
  });

  test('buildDiscordSnapshot resolves 1P direction from market_context when selection side is missing', () => {
    const cards = [
      makeCard({
        id: 'pace-1p-market-context-side',
        sport: 'nhl',
        cardType: 'nhl-pace-1p',
        payloadData: {
          action: 'LEAN',
          kind: 'PLAY',
          market_type: 'FIRST_PERIOD',
          period: '1P',
          selection: { line: 1.5 },
          market_context: { selection_side: 'UNDER' },
          line: 1.5,
          edge: 0.6,
          model_projection: 1.2,
          price: -110,
          projection_only: false,
        },
      }),
    ];

    const snapshot = buildDiscordSnapshot({ cards, now: new Date('2026-03-20T14:00:00.000Z') });

    expect(snapshot.messages[0]).toContain('1P | UNDER 1.5 (-110)');
    expect(snapshot.messages[0]).not.toContain('1P | 1.5');
  });

  test('buildDiscordSnapshot ignores numeric 1P selection token and uses prediction side', () => {
    const cards = [
      makeCard({
        id: 'pace-1p-numeric-selection',
        sport: 'nhl',
        cardType: 'nhl-pace-1p',
        payloadData: {
          action: 'FIRE',
          kind: 'PLAY',
          market_type: 'FIRST_PERIOD',
          period: '1P',
          selection: 1.5,
          prediction: 'OVER',
          line: 1.5,
          edge: 0.8,
          model_projection: 2.1,
          price: -105,
          projection_only: false,
        },
      }),
    ];

    const snapshot = buildDiscordSnapshot({ cards, now: new Date('2026-03-20T14:00:00.000Z') });

    expect(snapshot.messages[0]).toContain('1P | OVER 1.5 (-105)');
    expect(snapshot.messages[0]).not.toContain('1P | 1.5');
  });

  test('buildDiscordSnapshot keeps directional 1P cards when projection exists but 1P price is unavailable', () => {
    const cards = [
      makeCard({
        id: 'pace-1p-no-proj-directional',
        sport: 'nhl',
        cardType: 'nhl-pace-1p',
        payloadData: {
          action: 'PASS',
          status: 'PASS',
          kind: 'PLAY',
          market_type: 'FIRST_PERIOD',
          period: '1P',
          prediction: 'BEST_OVER',
          selection: { side: 'OVER' },
          line: 1.5,
          price: null,
          pass_reason_code: 'FIRST_PERIOD_PRICE_UNAVAILABLE',
          nhl_1p_decision: {
            projection: {
              exists: true,
              side: 'OVER',
              model_label: 'BEST_OVER',
            },
            execution: {
              market_available: true,
              price_available: false,
              is_executable: false,
              execution_reason: 'PRICE_UNAVAILABLE',
            },
            surfaced_status: 'SLIGHT EDGE',
            surfaced_reason_code: 'FIRST_PERIOD_PRICE_UNAVAILABLE',
          },
          projection_only: false,
        },
      }),
    ];

    const snapshot = buildDiscordSnapshot({ cards, now: new Date('2026-03-20T14:00:00.000Z') });

    expect(snapshot.totalGames).toBe(1);
    expect(snapshot.sectionCounts.lean).toBe(1);
    expect(snapshot.messages[0]).toContain('🟡 Slight Edge');
    expect(snapshot.messages[0]).toContain('1P | OVER 1.5');
  });

  test('buildDiscordSnapshot can restrict webhook output to official buckets only via env', () => {
    const originalBuckets = process.env.DISCORD_CARD_WEBHOOK_BUCKETS;
    process.env.DISCORD_CARD_WEBHOOK_BUCKETS = 'play';

    try {
      const cards = [
        makeCard({
          id: 'official-only',
          matchup: 'Boston Bruins @ New York Rangers',
          payloadData: {
            action: 'FIRE',
            kind: 'PLAY',
            market_type: 'MONEYLINE',
            selection: { side: 'HOME' },
            price: -115,
            projection_only: false,
          },
        }),
        makeCard({
          id: 'lean-filtered-out',
          matchup: 'Dallas Stars @ Toronto Maple Leafs',
          payloadData: {
            action: 'LEAN',
            kind: 'PLAY',
            market_type: 'TOTAL',
            selection: { side: 'OVER' },
            line: 5.5,
            edge: 0.7,
            model_projection: 6.2,
            price: -110,
            projection_only: false,
          },
        }),
      ];

      const snapshot = buildDiscordSnapshot({ cards, now: new Date('2026-03-20T14:00:00.000Z') });

      expect(snapshot.totalGames).toBe(1);
      expect(snapshot.sectionCounts.official).toBe(1);
      expect(snapshot.sectionCounts.lean).toBe(0);
      expect(snapshot.messages[0]).toContain('🟢 PLAY');
      expect(snapshot.messages[0]).not.toContain('🟡 Slight Edge');
    } finally {
      if (originalBuckets !== undefined) process.env.DISCORD_CARD_WEBHOOK_BUCKETS = originalBuckets;
      else delete process.env.DISCORD_CARD_WEBHOOK_BUCKETS;
    }
  });

  test('buildDiscordSnapshot can restrict webhook output by market via env', () => {
    const originalMarkets = process.env.DISCORD_CARD_WEBHOOK_MARKETS;
    process.env.DISCORD_CARD_WEBHOOK_MARKETS = '1p';

    try {
      const cards = [
        makeCard({
          id: 'allowed-1p',
          matchup: 'Washington Capitals @ Columbus Blue Jackets',
          sport: 'nhl',
          cardType: 'nhl-pace-1p',
          payloadData: {
            action: 'LEAN',
            kind: 'PLAY',
            market_type: 'TOTAL',
            period: '1P',
            selection: { side: 'UNDER' },
            line: 1.5,
            edge: 0.8,
            model_projection: 1.1,
            price: -112,
            projection_only: false,
          },
        }),
        makeCard({
          id: 'filtered-total',
          matchup: 'New Jersey Devils @ Boston Bruins',
          sport: 'nhl',
          cardType: 'nhl-totals-call',
          payloadData: {
            action: 'FIRE',
            kind: 'PLAY',
            market_type: 'TOTAL',
            selection: { side: 'UNDER' },
            line: 5.5,
            edge: -1.4,
            model_projection: 4.2,
            price: -105,
            projection_only: false,
          },
        }),
      ];

      const snapshot = buildDiscordSnapshot({ cards, now: new Date('2026-03-20T14:00:00.000Z') });

      expect(snapshot.totalGames).toBe(1);
      expect(snapshot.totalCards).toBe(2);
      expect(snapshot.sectionCounts.lean).toBe(1);
      expect(snapshot.sectionCounts.official).toBe(0);
      expect(snapshot.messages[0]).toContain('1P | UNDER 1.5 (-112)');
      expect(snapshot.messages[0]).not.toContain('TOTAL | UNDER 5.5 (-105)');
    } finally {
      if (originalMarkets !== undefined) process.env.DISCORD_CARD_WEBHOOK_MARKETS = originalMarkets;
      else delete process.env.DISCORD_CARD_WEBHOOK_MARKETS;
    }
  });

  test('buildDiscordSnapshot promotes NHL total to PLAY section at edge >= 1.0 (was: play-grade label)', () => {
    const pd = {
      action: 'LEAN',
      kind: 'PLAY',
      market_type: 'TOTAL',
      selection: { side: 'OVER' },
      price: -110,
      line: 6.0,
      edge: 1.1,
      model_projection: 6.8,
      projection_only: false,
    };
    stampNhlTotals(pd);
    const cards = [makeCard({ id: 'play-grade', payloadData: pd })];

    const snapshot = buildDiscordSnapshot({ cards, now: new Date('2026-03-20T14:00:00.000Z') });
    // edge=1.1 >= 1.0, line=6.0 (not >= 6.5), no integrity/uncertainty issues → official bucket
    expect(snapshot.sectionCounts.official).toBe(1);
    expect(snapshot.sectionCounts.lean).toBe(0);
    expect(snapshot.messages[0]).toContain('🟢 PLAY');
    expect(snapshot.messages[0]).not.toContain('Play-Grade Edge');
  });

  test('buildDiscordSnapshot promotes NHL total UNDER 6.5 to PLAY section at edge >= 1.5 (was: strong label)', () => {
    const pd = {
      action: 'WATCH',
      kind: 'PLAY',
      market_type: 'TOTAL',
      selection: { side: 'UNDER' },
      price: -102,
      line: 6.5,
      edge: 1.6,
      model_projection: 5.5,
      projection_only: false,
    };
    stampNhlTotals(pd);
    const cards = [makeCard({ id: 'strong-play-under', payloadData: pd })];

    const snapshot = buildDiscordSnapshot({ cards, now: new Date('2026-03-20T14:00:00.000Z') });
    // edge=1.6 >= 1.0, UNDER on 6.5 (neither UNDER ≤5.5 nor OVER ≥6.5 fragility) → official bucket
    expect(snapshot.sectionCounts.official).toBe(1);
    expect(snapshot.sectionCounts.lean).toBe(0);
    expect(snapshot.messages[0]).toContain('🟢 PLAY');
    expect(snapshot.messages[0]).not.toContain('Strong Play Edge');
  });

  test('buildDiscordSnapshot does not print @ null when price is missing', () => {
    const cards = [
      makeCard({
        id: 'price-missing-1',
        matchup: 'LIVERPOOL @ BRIGHTON',
        cardType: 'nhl-moneyline-call',
        payloadData: {
          action: 'FIRE',
          kind: 'PLAY',
          market_type: 'MONEYLINE',
          selection: { side: 'HOME' },
          price: null,
          projection_only: false,
        },
      }),
    ];

    const snapshot = buildDiscordSnapshot({ cards, now: new Date('2026-03-20T17:00:00.000Z') });

    expect(snapshot.totalCards).toBe(1);
    expect(snapshot.messages[0]).not.toContain('(@ null)');
  });

  test('buildDiscordSnapshot collapses conflicting market sides to a single latest pick', () => {
    const cards = [
      makeCard({
        id: 'spread-away',
        gameId: 'game-1',
        cardType: 'nhl-spread-call',
        createdAt: '2026-03-20T16:59:00.000Z',
        payloadData: {
          action: 'FIRE',
          kind: 'PLAY',
          market_type: 'SPREAD',
          selection: { side: 'AWAY' },
          line: -0.25,
          price: -114,
          projection_only: false,
        },
      }),
      makeCard({
        id: 'spread-home',
        gameId: 'game-1',
        cardType: 'nhl-spread-call',
        createdAt: '2026-03-20T17:01:00.000Z',
        payloadData: {
          action: 'FIRE',
          kind: 'PLAY',
          market_type: 'SPREAD',
          selection: { side: 'HOME' },
          line: 0.25,
          price: 105,
          projection_only: false,
        },
      }),
    ];

    const snapshot = buildDiscordSnapshot({ cards, now: new Date('2026-03-20T17:05:00.000Z') });

    expect(snapshot.totalCards).toBe(1);
    expect(snapshot.messages[0]).toContain('Spread');
    expect(snapshot.messages[0]).toContain('HOME');
    expect(snapshot.messages[0]).not.toContain('AWAY -0.25');
  });

  test('chunkDiscordContent splits long payloads into ordered chunks under limit', () => {
    const line = 'x'.repeat(120);
    const content = new Array(40).fill(line).join('\n');
    const chunks = chunkDiscordContent(content, 500);

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => chunk.length <= 500)).toBe(true);
    expect(chunks.join('\n').replace(/\n+/g, '\n')).toContain('x'.repeat(60));
  });

  test('postDiscordCards skips with disabled reason when ENABLE_DISCORD_CARD_WEBHOOKS is unset', async () => {
    const origEnv = process.env.ENABLE_DISCORD_CARD_WEBHOOKS;
    delete process.env.ENABLE_DISCORD_CARD_WEBHOOKS;

    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    const result = await postDiscordCards();

    expect(result.success).toBe(true);
    expect(result.skipped).toBe(true);
    expect(result.reason).toBe('disabled');
    // Must emit actionable console.log mentioning the skip
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('[post-discord-cards] Skipping'));

    logSpy.mockRestore();
    if (origEnv !== undefined) process.env.ENABLE_DISCORD_CARD_WEBHOOKS = origEnv;
  });

  test('postDiscordCards skips with missing_webhook_url reason when ENABLE_DISCORD_CARD_WEBHOOKS=true but URL unset', async () => {
    const origEnabled = process.env.ENABLE_DISCORD_CARD_WEBHOOKS;
    const origUrl = process.env.DISCORD_CARD_WEBHOOK_URL;
    process.env.ENABLE_DISCORD_CARD_WEBHOOKS = 'true';
    delete process.env.DISCORD_CARD_WEBHOOK_URL;

    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    const result = await postDiscordCards();

    expect(result.success).toBe(true);
    expect(result.skipped).toBe(true);
    expect(result.reason).toBe('missing_webhook_url');
    // Must emit actionable console.log mentioning the skip
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('[post-discord-cards] Skipping'));

    logSpy.mockRestore();
    if (origEnabled !== undefined) process.env.ENABLE_DISCORD_CARD_WEBHOOKS = origEnabled;
    else delete process.env.ENABLE_DISCORD_CARD_WEBHOOKS;
    if (origUrl !== undefined) process.env.DISCORD_CARD_WEBHOOK_URL = origUrl;
  });

  test('sendDiscordMessages posts chunks in order without numbering prefix', async () => {
    const calls = [];
    const fakeFetch = jest.fn(async (url, init) => {
      calls.push({ url, init });
      return { ok: true, status: 204, text: async () => '' };
    });

    const sent = await sendDiscordMessages({
      webhookUrl: 'https://discord.example/webhook',
      messages: ['first', 'second', 'third'],
      fetchImpl: fakeFetch,
    });

    expect(sent).toBe(3);
    expect(calls.length).toBe(3);
    expect(JSON.parse(calls[0].init.body).content).toBe('first');
    expect(JSON.parse(calls[1].init.body).content).toBe('second');
    expect(JSON.parse(calls[2].init.body).content).toBe('third');
  });

  test('buildDiscordSnapshot surfaces price_staleness_warning line when present on a hard-locked card', () => {
    const stalenessCard = makeCard({
      id: 'stale-1',
      cardType: 'nhl-model-output',
      payloadData: {
        action: 'LEAN',
        kind: 'PLAY',
        pass_reason: null,
        pass_reason_code: null,
        market_type: 'TOTAL',
        selection: { side: 'OVER' },
        price: -110,
        line: 5.5,
        projection_only: false,
        edge: 0.8,
        model_projection: 6.1,
        price_staleness_warning: {
          locked_price: -110,
          current_candidate_price: -130,
          delta_american: 20,
          minutes_to_start: 30,
          reason: 'HARD_LOCK_PRICE_DRIFT',
        },
        tags: ['PUBLISHED_FROM_GATE', 'PRICE_STALENESS_WARNING'],
      },
    });

    const snapshot = buildDiscordSnapshot({ cards: [stalenessCard], now: new Date('2026-03-20T14:00:00.000Z') });

    expect(snapshot.messages[0]).toContain('Hard-locked at -110');
    expect(snapshot.messages[0]).toContain('-130');
    expect(snapshot.messages[0]).toContain('20 pts drift');
    expect(snapshot.messages[0]).toContain('T-30min');
  });

  test('buildDiscordSnapshot does not include staleness warning line when price_staleness_warning is absent', () => {
    const cleanCard = makeCard({
      id: 'clean-1',
      cardType: 'nhl-model-output',
      payloadData: {
        action: 'LEAN',
        kind: 'PLAY',
        pass_reason: null,
        market_type: 'TOTAL',
        selection: { side: 'OVER' },
        price: -110,
        line: 5.5,
        projection_only: false,
        edge: 0.8,
        model_projection: 6.1,
      },
    });

    const snapshot = buildDiscordSnapshot({ cards: [cleanCard], now: new Date('2026-03-20T14:00:00.000Z') });

    expect(snapshot.messages).toHaveLength(1);
    expect(snapshot.messages[0]).not.toContain('Hard-locked');
  });
});

// ---------------------------------------------------------------------------
// WI-0934: NHL totals bucket policy enforcement
// ---------------------------------------------------------------------------
describe('WI-0934: NHL totals bucket policy — PLAY / SLIGHT EDGE / PASS', () => {
  function makeNhlTotalCard(overrides = {}) {
    const card = {
      id: 'nhl-total-1',
      sport: 'nhl',
      matchup: 'Carolina Hurricanes @ Philadelphia Flyers',
      cardType: 'nhl-totals-call',
      gameTimeUtc: new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString(),
      payloadData: {
        action: 'LEAN',
        kind: 'PLAY',
        market_type: 'TOTAL',
        selection: { side: 'OVER' },
        price: -110,
        line: 5.5,
        edge: 2.1,
        model_projection: 7.2,
        projection_only: false,
      },
      ...overrides,
    };
    // Simulate model-runner + publisher: stamp nhl_totals_status → webhook_* fields
    stampNhlTotals(card.payloadData);
    return card;
  }

  // ── High-delta over on 5.5 → PLAY ─────────────────────────────────────────
  test('CAR/PHI +2.1 over 5.5 clean → official PLAY bucket', () => {
    const card = makeNhlTotalCard(); // edge=2.1, line=5.5, OVER, clean
    const snapshot = buildDiscordSnapshot({ cards: [card], now: new Date('2026-04-13T20:00:00Z') });
    expect(snapshot.sectionCounts.official).toBe(1);
    expect(snapshot.sectionCounts.lean).toBe(0);
    expect(snapshot.messages[0]).toContain('🟢 PLAY');
  });

  // ── WPG/VGK thin edge → SLIGHT EDGE, never equal to +2.1 ──────────────────
  test('WPG/VGK +0.5 over 5.5 → lean bucket, never equal to +2.1 PLAY', () => {
    const card = makeNhlTotalCard({
      id: 'wpg-vgk',
      matchup: 'Winnipeg Jets @ Vegas Golden Knights',
      payloadData: {
        action: 'LEAN', kind: 'PLAY', market_type: 'TOTAL',
        selection: { side: 'OVER' }, price: -110, line: 5.5, edge: 0.5,
        model_projection: 5.8, projection_only: false,
      },
    });
    const snapshot = buildDiscordSnapshot({ cards: [card], now: new Date('2026-04-13T20:00:00Z') });
    expect(snapshot.sectionCounts.official).toBe(0);
    expect(snapshot.sectionCounts.lean).toBe(1);
    expect(snapshot.messages[0]).not.toContain('🟢 PLAY');
    expect(snapshot.messages[0]).toContain('🟡 Slight Edge');
  });

  // ── OVER 6.5 without adequate accelerant → caps PLAY to SLIGHT EDGE ────────
  test('Over 6.5 without adequate accelerant caps PLAY to SLIGHT EDGE', () => {
    const card = makeNhlTotalCard({
      id: 'over65-no-accel',
      payloadData: {
        action: 'LEAN', kind: 'PLAY', market_type: 'TOTAL',
        selection: { side: 'OVER' }, price: -108, line: 6.5, edge: 1.2,
        model_projection: 7.6, projection_only: false,
        accelerant_score: 0.10, // below 0.20 threshold
      },
    });
    const snapshot = buildDiscordSnapshot({ cards: [card], now: new Date('2026-04-13T20:00:00Z') });
    // edge=1.2 would be PLAY, but OVER 6.5 + accelerant 0.10 < 0.20 caps to SLIGHT EDGE
    expect(snapshot.sectionCounts.official).toBe(0);
    expect(snapshot.sectionCounts.lean).toBe(1);
    expect(snapshot.messages[0]).not.toContain('🟢 PLAY');
  });

  // ── OVER 6.5 with adequate accelerant → PLAY allowed ─────────────────────
  test('Over 6.5 with adequate accelerant_score 0.25 stays PLAY', () => {
    const card = makeNhlTotalCard({
      id: 'over65-accel-ok',
      payloadData: {
        action: 'LEAN', kind: 'PLAY', market_type: 'TOTAL',
        selection: { side: 'OVER' }, price: -106, line: 6.5, edge: 1.2,
        model_projection: 7.7, projection_only: false,
        accelerant_score: 0.25, // passes threshold
      },
    });
    const snapshot = buildDiscordSnapshot({ cards: [card], now: new Date('2026-04-13T20:00:00Z') });
    expect(snapshot.sectionCounts.official).toBe(1);
    expect(snapshot.messages[0]).toContain('🟢 PLAY');
  });

  // ── COL/EDM UNDER 6.5 at -1.5 → PLAY (no fragility rule applies) ──────────
  test('COL/EDM Under 6.5 at -1.5 → official PLAY (UNDER 6.5 is not UNDER 5.5)', () => {
    const card = makeNhlTotalCard({
      id: 'col-edm',
      matchup: 'Colorado Avalanche @ Edmonton Oilers',
      payloadData: {
        action: 'LEAN', kind: 'PLAY', market_type: 'TOTAL',
        selection: { side: 'UNDER' }, price: -105, line: 6.5, edge: -1.5,
        model_projection: 5.1, projection_only: false,
      },
    });
    const snapshot = buildDiscordSnapshot({ cards: [card], now: new Date('2026-04-13T20:00:00Z') });
    expect(snapshot.sectionCounts.official).toBe(1);
    expect(snapshot.messages[0]).toContain('🟢 PLAY');
  });

  // ── UNDER 5.5 auto-downgrade: SLIGHT_EDGE → PASS ─────────────────────────
  test('Under 5.5 with edge=-0.8 gets one-tier downgrade: SLIGHT_EDGE → PASS', () => {
    const card = makeNhlTotalCard({
      id: 'under-5.5-slim',
      payloadData: {
        action: 'LEAN', kind: 'PLAY', market_type: 'TOTAL',
        selection: { side: 'UNDER' }, price: -112, line: 5.5, edge: -0.8,
        model_projection: 4.8, projection_only: false,
      },
    });
    const snapshot = buildDiscordSnapshot({ cards: [card], now: new Date('2026-04-13T20:00:00Z') });
    // base=SLIGHT_EDGE, UNDER ≤5.5 → downgrade → PASS
    expect(snapshot.sectionCounts.official).toBe(0);
    expect(snapshot.sectionCounts.lean).toBe(0);
    expect(snapshot.messages).toHaveLength(0);
  });

  // ── UNDER 5.5 with PLAY-grade edge: PLAY → SLIGHT_EDGE ───────────────────
  test('Under 5.5 with edge=-1.5 (PLAY base) gets one-tier downgrade to SLIGHT EDGE', () => {
    const card = makeNhlTotalCard({
      id: 'under-5.5-strong',
      payloadData: {
        action: 'LEAN', kind: 'PLAY', market_type: 'TOTAL',
        selection: { side: 'UNDER' }, price: -108, line: 5.5, edge: -1.5,
        model_projection: 4.2, projection_only: false,
      },
    });
    const snapshot = buildDiscordSnapshot({ cards: [card], now: new Date('2026-04-13T20:00:00Z') });
    // base=PLAY, UNDER ≤5.5 → downgrade → SLIGHT_EDGE → lean
    expect(snapshot.sectionCounts.official).toBe(0);
    expect(snapshot.sectionCounts.lean).toBe(1);
    expect(snapshot.messages[0]).not.toContain('🟢 PLAY');
  });

  // ── Mixed-book integrity veto → always PASS ───────────────────────────────
  test('Mixed-book integrity block forces PASS regardless of edge', () => {
    const card = makeNhlTotalCard({
      id: 'mixed-book',
      payloadData: {
        action: 'LEAN', kind: 'PLAY', market_type: 'TOTAL',
        selection: { side: 'OVER' }, price: -110, line: 5.5, edge: 2.1,
        model_projection: 7.2, projection_only: false,
        blocked_reason_code: 'MIXED_BOOK_INTEGRITY_GATE',
        reason_codes: ['MIXED_BOOK_INTEGRITY_GATE'],
      },
    });
    const snapshot = buildDiscordSnapshot({ cards: [card], now: new Date('2026-04-13T20:00:00Z') });
    expect(snapshot.sectionCounts.official).toBe(0);
    expect(snapshot.sectionCounts.lean).toBe(0);
    expect(snapshot.messages).toHaveLength(0);
  });

  // ── Goalie uncertainty caps medium edge at SLIGHT EDGE ────────────────────
  test('Goalie uncertainty hold caps medium edge (+1.2) at SLIGHT EDGE, not PLAY', () => {
    const card = makeNhlTotalCard({
      id: 'goalie-uncertain-medium',
      matchup: 'New York Rangers @ Florida Panthers',
      payloadData: {
        action: 'LEAN', kind: 'PLAY', market_type: 'TOTAL',
        selection: { side: 'OVER' }, price: -110, line: 6.0, edge: 1.2,
        model_projection: 7.0, projection_only: false,
        reason_codes: ['GOALIE_UNCONFIRMED'],
      },
    });
    const snapshot = buildDiscordSnapshot({ cards: [card], now: new Date('2026-04-13T20:00:00Z') });
    // edge=1.2 would be PLAY, but uncertainty hold caps at SLIGHT_EDGE
    expect(snapshot.sectionCounts.official).toBe(0);
    expect(snapshot.sectionCounts.lean).toBe(1);
    expect(snapshot.messages[0]).not.toContain('🟢 PLAY');
  });

  // ── Goalie uncertainty caps thin edge to PASS ─────────────────────────────
  test('Goalie uncertainty hold with thin edge (+0.4) results in PASS', () => {
    const card = makeNhlTotalCard({
      id: 'goalie-uncertain-thin',
      payloadData: {
        action: 'LEAN', kind: 'PLAY', market_type: 'TOTAL',
        selection: { side: 'OVER' }, price: -110, line: 5.5, edge: 0.4,
        model_projection: 5.9, projection_only: false,
        reason_codes: ['GOALIE_UNCONFIRMED'],
      },
    });
    const snapshot = buildDiscordSnapshot({ cards: [card], now: new Date('2026-04-13T20:00:00Z') });
    // edge=0.4 < 0.5 (SLIGHT_EDGE floor), uncertainty hold → PASS
    expect(snapshot.sectionCounts.official).toBe(0);
    expect(snapshot.sectionCounts.lean).toBe(0);
    expect(snapshot.messages).toHaveLength(0);
  });

  // ── Sub-threshold edge → PASS ──────────────────────────────────────────────
  test('Edge below 0.35 (noise floor) always PASS regardless of other inputs', () => {
    const card = makeNhlTotalCard({
      id: 'noise-floor',
      payloadData: {
        action: 'LEAN', kind: 'PLAY', market_type: 'TOTAL',
        selection: { side: 'OVER' }, price: -110, line: 5.5, edge: 0.2,
        model_projection: 5.7, projection_only: false,
      },
    });
    const snapshot = buildDiscordSnapshot({ cards: [card], now: new Date('2026-04-13T20:00:00Z') });
    expect(snapshot.sectionCounts.official).toBe(0);
    expect(snapshot.sectionCounts.lean).toBe(0);
    expect(snapshot.messages).toHaveLength(0);
  });

  // ── NYR/FLA: OVER 6.5 at +0.6, weak accelerant → PASS under canonical fragility ──
  test('NYR/FLA +0.6 over 6.5 with weak accelerant downgrades to PASS', () => {
    const card = makeNhlTotalCard({
      id: 'nyr-fla',
      matchup: 'New York Rangers @ Florida Panthers',
      payloadData: {
        action: 'LEAN', kind: 'PLAY', market_type: 'TOTAL',
        selection: { side: 'OVER' }, price: -108, line: 6.5, edge: 0.6,
        model_projection: 6.9, projection_only: false,
        accelerant_score: 0.10, // weak — canonical policy downgrades SLIGHT_EDGE to PASS on OVER 6.5
      },
    });
    const snapshot = buildDiscordSnapshot({ cards: [card], now: new Date('2026-04-13T20:00:00Z') });
    // base=SLIGHT_EDGE (0.6 < 1.0), OVER-6.5 weak accelerant → PASS
    expect(snapshot.sectionCounts.official).toBe(0);
    expect(snapshot.sectionCounts.lean).toBe(0);
    expect(snapshot.messages).toHaveLength(0);
  });

  // ── Slate regression: all 5 games correct ────────────────────────────────
  test('Slate regression: high-delta cards surface as PLAY, thin as SLIGHT EDGE', () => {
    const now = new Date('2026-04-13T22:00:00Z');
    const gameTime = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString();

    function slateCard(id, matchup, side, line, edge, extra = {}) {
      const pd = {
        action: 'LEAN', kind: 'PLAY', market_type: 'TOTAL',
        selection: { side }, price: -110, line, edge: side === 'UNDER' ? -Math.abs(edge) : Math.abs(edge),
        model_projection: line + (side === 'OVER' ? Math.abs(edge) : -Math.abs(edge)),
        projection_only: false,
        ...extra,
      };
      stampNhlTotals(pd);
      return { id, sport: 'nhl', matchup, cardType: 'nhl-totals-call', gameTimeUtc: gameTime, payloadData: pd };
    }

    const cards = [
      slateCard('car-phi', 'Carolina Hurricanes @ Philadelphia Flyers', 'OVER', 5.5, 2.1),  // PLAY
      slateCard('min-stl', 'Minnesota Wild @ St. Louis Blues', 'OVER', 5.5, 1.2),             // PLAY
      slateCard('lak-sea', 'Los Angeles Kings @ Seattle Kraken', 'OVER', 5.5, 1.3),           // PLAY
      slateCard('col-edm', 'Colorado Avalanche @ Edmonton Oilers', 'UNDER', 6.5, 1.5),        // PLAY
      slateCard('nyr-fla', 'New York Rangers @ Florida Panthers', 'OVER', 6.5, 0.6,           // SLIGHT EDGE
        { accelerant_score: 0.10 }),
      slateCard('wpg-vgk', 'Winnipeg Jets @ Vegas Golden Knights', 'OVER', 5.5, 0.5),         // SLIGHT EDGE
    ];

    const snapshot = buildDiscordSnapshot({ cards, now });
    // One card (NYR/FLA) is now PASS under canonical OVER-6.5 fragility.
    // Canonical-path pass_blocked cards are excluded in isDisplayableWebhookCard so they
    // never reach the game loop — passBlocked counter is 0 (correct for Layer B).
    expect(snapshot.totalGames).toBe(5);
    // 4 PLAY cards: CAR/PHI, MIN/STL, LAK/SEA, COL/EDM
    expect(snapshot.sectionCounts.official).toBe(4);
    // 1 SLIGHT EDGE card: WPG/VGK
    expect(snapshot.sectionCounts.lean).toBe(1);
    // NYR/FLA filtered upstream by webhook_eligible=false — does not appear in loop
    expect(snapshot.sectionCounts.passBlocked).toBe(0);

    // All six game messages include a separator line
    expect(snapshot.messages.every((m) => m.includes('─'))).toBe(true);
  });
});

describe('canonical webhook fields path', () => {
  // classifyDecisionBucket reads webhook_bucket
  it('classifyDecisionBucket returns official when webhook_bucket=official', () => {
    const card = makeCard({ payloadData: { webhook_bucket: 'official' } });
    expect(classifyDecisionBucket(card)).toBe('official');
  });

  it('classifyDecisionBucket returns lean when webhook_bucket=lean', () => {
    const card = makeCard({ payloadData: { webhook_bucket: 'lean' } });
    expect(classifyDecisionBucket(card)).toBe('lean');
  });

  it('classifyDecisionBucket returns pass_blocked when webhook_bucket=pass_blocked', () => {
    const card = makeCard({ payloadData: { webhook_bucket: 'pass_blocked' } });
    expect(classifyDecisionBucket(card)).toBe('pass_blocked');
  });

  it('classifyDecisionBucket falls back to legacy when no webhook_bucket', () => {
    const card = makeCard({
      payloadData: { action: 'FIRE', classification: 'BASE' },
    });
    expect(classifyDecisionBucket(card)).toBe('official');
  });

  it('classifyDecisionBucket returns pass_blocked for EVIDENCE card with pre-stamped webhook_bucket=official', () => {
    // Regression: nhl-base-projection / nhl-model-output EVIDENCE cards had action=FIRE
    // and computeWebhookFields stamped webhook_bucket='official'. Formatter must ignore that.
    const card = makeCard({
      cardType: 'nhl-base-projection',
      payloadData: {
        kind: 'EVIDENCE',
        action: 'FIRE',
        webhook_bucket: 'official',
        webhook_eligible: true,
        prediction: 'AWAY',
      },
    });
    expect(classifyDecisionBucket(card)).toBe('pass_blocked');
  });

  // isDisplayableWebhookCard reads webhook_eligible
  it('isDisplayableWebhookCard returns true when webhook_eligible=true', () => {
    const card = makeCard({ payloadData: { webhook_eligible: true } });
    expect(isDisplayableWebhookCard(card)).toBe(true);
  });

  it('isDisplayableWebhookCard returns false when webhook_eligible=false', () => {
    const card = makeCard({ payloadData: { webhook_eligible: false } });
    expect(isDisplayableWebhookCard(card)).toBe(false);
  });

  it('isDisplayableWebhookCard returns false for EVIDENCE card with pre-stamped webhook_eligible=true', () => {
    // Regression: EVIDENCE cards (nhl-rest-advantage, nhl-goalie-certainty, etc.) were written
    // with webhook_eligible=true and webhook_bucket='official' when action=FIRE, causing false
    // PLAY sections to appear in Discord for games where all real bet calls were blocked.
    const card = makeCard({
      cardType: 'nhl-rest-advantage',
      payloadData: {
        kind: 'EVIDENCE',
        action: 'FIRE',
        webhook_eligible: true,
        webhook_bucket: 'official',
        prediction: 'NEUTRAL',
        selection: null,
      },
    });
    expect(isDisplayableWebhookCard(card)).toBe(false);
  });

  // passesLeanThreshold reads webhook_lean_eligible
  it('passesLeanThreshold returns false when webhook_lean_eligible=false', () => {
    const card = makeCard({ payloadData: { webhook_lean_eligible: false } });
    expect(passesLeanThreshold(card)).toBe(false);
  });

  it('passesLeanThreshold returns true when webhook_lean_eligible=true', () => {
    const card = makeCard({ payloadData: { webhook_lean_eligible: true } });
    expect(passesLeanThreshold(card)).toBe(true);
  });

  // selectionSummary reads webhook_display_side
  it('selectionSummary returns webhook_display_side when present', () => {
    const card = makeCard({ payloadData: { webhook_display_side: 'OVER' } });
    expect(selectionSummary(card)).toBe('OVER');
  });
});

describe('postDiscordCards integration', () => {
  const TEST_DB_PATH = '/tmp/cheddar-test-post-discord-cards.db';
  const LOCK_PATH = `${TEST_DB_PATH}.lock`;
  let dataModule;

  function removeIfExists(filePath) {
    try {
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    } catch {
      // best effort
    }
  }

  function resetTables() {
    const db = new Database(TEST_DB_PATH);
    db.exec(`
      DELETE FROM card_results;
      DELETE FROM card_payloads;
      DELETE FROM games;
      DELETE FROM job_runs;
    `);
    db.close();
  }

  beforeAll(async () => {
    process.env.CHEDDAR_DB_PATH = TEST_DB_PATH;
    process.env.CHEDDAR_DB_AUTODISCOVER = 'false';
    process.env.CHEDDAR_DB_ALLOW_MULTI_PROCESS = 'false';
    process.env.ENABLE_DISCORD_CARD_WEBHOOKS = 'true';
    process.env.DISCORD_CARD_WEBHOOK_URL = 'https://discord.example/cards';

    removeIfExists(TEST_DB_PATH);
    removeIfExists(LOCK_PATH);

    dataModule = require('@cheddar-logic/data');
    await dataModule.runMigrations();
    dataModule.closeDatabase();
  });

  beforeEach(() => {
    dataModule.closeDatabase();
    resetTables();
  });

  afterAll(() => {
    try {
      dataModule.closeDatabase();
    } catch {
      // best effort
    }
  });

  test('dry-run snapshot excludes potd-call from generic Discord cards feed', async () => {
    const db = new Database(TEST_DB_PATH);
    db.prepare(
      `INSERT INTO games (id, sport, game_id, home_team, away_team, game_time_utc, status)
       VALUES (?, 'nhl', ?, ?, ?, ?, 'scheduled')`,
    ).run(
      'game-1',
      'game-1',
      'Boston Bruins',
      'Toronto Maple Leafs',
      '2035-04-10T20:00:00.000Z',
    );
    db.prepare(
      `INSERT INTO card_payloads (id, game_id, sport, card_type, card_title, created_at, payload_data)
       VALUES
       (?, ?, 'nhl', 'potd-call', 'POTD', '2026-04-09T18:00:00.000Z', ?),
       (?, ?, 'nhl', 'nhl-moneyline-call', 'Regular Card', '2026-04-09T18:01:00.000Z', ?)`,
    ).run(
      'potd-card',
      'game-1',
      JSON.stringify({
        action: 'FIRE',
        kind: 'PLAY',
        market_type: 'TOTAL',
        selection: { side: 'OVER' },
        price: 115,
        line: 5.5,
      }),
      'regular-card',
      'game-1',
      JSON.stringify({
        action: 'FIRE',
        kind: 'PLAY',
        market_type: 'MONEYLINE',
        selection: { side: 'HOME' },
        price: -115,
        line: null,
      }),
    );
    db.close();

    const result = await postDiscordCards({
      dryRun: true,
      now: new Date('2035-04-10T12:00:00.000Z'),
    });
    expect(result.success).toBe(true);
    expect(result.totalCards).toBe(1);
  });
});

// ── PRI-DISPLAY-01: decisionReason() default is null, not fabricated PASS_NO_EDGE ─

describe('PRI-DISPLAY-01: decisionReason() display layer integrity', () => {
  test('Test J: no pass_reason_code, no reason_codes, no blocked_reason_code → returns null (not PASS_NO_EDGE)', () => {
    // Before fix: returns 'PASS_NO_EDGE' as a fabricated default
    // After fix: returns null (callers handle null gracefully)
    expect(decisionReason({ payloadData: {} })).toBeNull();
  });

  test('Test J (edge): undefined payloadData → returns null', () => {
    expect(decisionReason({})).toBeNull();
    expect(decisionReason(null)).toBeNull();
    expect(decisionReason(undefined)).toBeNull();
  });

  test('Test J2: pass_reason_code present → returns normalizeToken result', () => {
    const result = decisionReason({ payloadData: { pass_reason_code: 'PASS_CONFIDENCE_GATE' } });
    // normalizeToken converts to uppercase — 'PASS_CONFIDENCE_GATE' is already uppercase
    expect(result).toBe('PASS_CONFIDENCE_GATE');
  });

  test('Test J2b: reason_codes array → returns first code via normalizeToken', () => {
    const result = decisionReason({ payloadData: { reason_codes: ['PASS_SYNTHETIC_FALLBACK'] } });
    expect(result).toBe('PASS_SYNTHETIC_FALLBACK');
  });
});
