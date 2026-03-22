const {
  isNonPassCard,
  isDisplayableWebhookCard,
  buildDiscordSnapshot,
  chunkDiscordContent,
  sendDiscordMessages,
  postDiscordCards,
} = require('../post_discord_cards');

function makeCard(overrides = {}) {
  return {
    id: 'card-1',
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
    expect(snapshot.messages[0]).toContain('🟡 LEAN');
    expect(snapshot.messages[0]).not.toContain('⚪ PASS');
  });

  test('buildDiscordSnapshot does not print @ null when price is missing', () => {
    const cards = [
      makeCard({
        id: 'soccer-1',
        matchup: 'LIVERPOOL @ BRIGHTON',
        cardType: 'soccer',
        payloadData: {
          action: 'FIRE',
          kind: 'PLAY',
          market_type: 'MONEYLINE',
          selection: { side: 'OVER' },
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
        id: 'soccer-away',
        gameId: 'soccer-game-1',
        cardType: 'asian_handicap_away',
        createdAt: '2026-03-20T16:59:00.000Z',
        payloadData: {
          action: 'FIRE',
          kind: 'PLAY',
          market_key: 'soccer_epl:asian_handicap',
          selection: { side: 'AWAY' },
          line: -0.25,
          price: -114,
          projection_only: false,
        },
      }),
      makeCard({
        id: 'soccer-home',
        gameId: 'soccer-game-1',
        cardType: 'asian_handicap_home',
        createdAt: '2026-03-20T17:01:00.000Z',
        payloadData: {
          action: 'FIRE',
          kind: 'PLAY',
          market_key: 'soccer_epl:asian_handicap',
          selection: { side: 'HOME' },
          line: 0.25,
          price: 105,
          projection_only: false,
        },
      }),
    ];

    const snapshot = buildDiscordSnapshot({ cards, now: new Date('2026-03-20T17:05:00.000Z') });

    expect(snapshot.totalCards).toBe(1);
    expect(snapshot.messages[0]).toContain('SPREAD');
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
    let result;
    try {
      result = await postDiscordCards();
    } finally {
      if (origEnv !== undefined) process.env.ENABLE_DISCORD_CARD_WEBHOOKS = origEnv;
      logSpy.mockRestore();
    }

    expect(result.success).toBe(true);
    expect(result.skipped).toBe(true);
    expect(result.reason).toBe('disabled');
    // Must emit actionable console.log mentioning the skip
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('[post-discord-cards] Skipping'));
  });

  test('postDiscordCards skips with missing_webhook_url reason when ENABLE_DISCORD_CARD_WEBHOOKS=true but URL unset', async () => {
    const origEnabled = process.env.ENABLE_DISCORD_CARD_WEBHOOKS;
    const origUrl = process.env.DISCORD_CARD_WEBHOOK_URL;
    process.env.ENABLE_DISCORD_CARD_WEBHOOKS = 'true';
    delete process.env.DISCORD_CARD_WEBHOOK_URL;

    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    let result;
    try {
      result = await postDiscordCards();
    } finally {
      if (origEnabled !== undefined) process.env.ENABLE_DISCORD_CARD_WEBHOOKS = origEnabled;
      else delete process.env.ENABLE_DISCORD_CARD_WEBHOOKS;
      if (origUrl !== undefined) process.env.DISCORD_CARD_WEBHOOK_URL = origUrl;
      logSpy.mockRestore();
    }

    expect(result.success).toBe(true);
    expect(result.skipped).toBe(true);
    expect(result.reason).toBe('missing_webhook_url');
    // Must emit actionable console.log mentioning the skip
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('[post-discord-cards] Skipping'));
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
});
