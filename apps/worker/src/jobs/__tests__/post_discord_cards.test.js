const {
  isNonPassCard,
  buildDiscordSnapshot,
  chunkDiscordContent,
  sendDiscordMessages,
} = require('../post_discord_cards');

function makeCard(overrides = {}) {
  return {
    id: 'card-1',
    matchup: 'Boston Bruins @ New York Rangers',
    cardType: 'nhl-model-output',
    payloadData: {
      action: 'FIRE',
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
  test('isNonPassCard excludes PASS and includes non-PASS projection-only rows', () => {
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

  test('buildDiscordSnapshot creates explicit core/player-props/1P sections', () => {
    const cards = [
      makeCard({ id: 'core-1', cardType: 'nhl-model-output' }),
      makeCard({
        id: 'prop-1',
        cardType: 'nhl_player_shots_props',
        payloadData: {
          action: 'WATCH',
          market_type: 'PROP',
          selection: { team: 'Player A' },
          price: -120,
          pass_reason: null,
        },
      }),
      makeCard({
        id: '1p-1',
        cardType: 'nhl-pace-1p',
        payloadData: {
          action: 'FIRE',
          market_type: 'TOTAL',
          period: '1P',
          selection: { side: 'OVER' },
          line: 1.5,
          price: -110,
          pass_reason: null,
        },
      }),
    ];

    const snapshot = buildDiscordSnapshot({ cards, now: new Date('2026-03-20T14:00:00.000Z') });

    expect(snapshot.totalCards).toBe(3);
    expect(snapshot.sectionCounts).toEqual({ core: 1, playerProps: 1, firstPeriod: 1 });
    expect(snapshot.content).toContain('Core Cards (1)');
    expect(snapshot.content).toContain('Player Props (1)');
    expect(snapshot.content).toContain('1P Cards (1)');
  });

  test('chunkDiscordContent splits long payloads into ordered chunks under limit', () => {
    const line = 'x'.repeat(120);
    const content = new Array(40).fill(line).join('\n');
    const chunks = chunkDiscordContent(content, 500);

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => chunk.length <= 500)).toBe(true);
    expect(chunks.join('\n').replace(/\n+/g, '\n')).toContain('x'.repeat(60));
  });

  test('sendDiscordMessages posts chunks in order with numbering prefix', async () => {
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
    expect(JSON.parse(calls[0].init.body).content).toContain('[1/3] first');
    expect(JSON.parse(calls[1].init.body).content).toContain('[2/3] second');
    expect(JSON.parse(calls[2].init.body).content).toContain('[3/3] third');
  });
});
