'use strict';

const { EventEmitter } = require('events');

const MONEYPUCK_URLS = {
  teams: 'https://moneypuck.com/teams.htm',
  goalies: 'https://moneypuck.com/goalies.htm',
  stats: 'https://moneypuck.com/stats.htm',
  injuries: 'https://moneypuck.com/injuries.htm',
  injuriesCsv:
    'https://moneypuck.com/moneypuck/playerData/playerNews/current_injuries.csv',
  power: 'https://moneypuck.com/power.htm',
};
const ROTOWIRE_BASE =
  'https://www.rotowire.com/hockey/tables/projected-goalies.php?date=';

const DEFAULT_TEAMS_HTML = `
  <table>
    <tr><th>Team</th><th>xGF%</th><th>PDO</th><th>PP%</th><th>PK%</th></tr>
    <tr><td>Montreal Canadiens</td><td>51.2</td><td>101.1</td><td>18.5</td><td>79.2</td></tr>
    <tr><td>Toronto Maple Leafs</td><td>53.3</td><td>100.2</td><td>24.1</td><td>80.5</td></tr>
  </table>
`;

const DEFAULT_STATS_HTML = `
  <table>
    <tr><th>Team</th><th>xGF%</th><th>PDO</th><th>PP%</th><th>PK%</th></tr>
    <tr><td>Montreal Canadiens</td><td>52.4</td><td>100.8</td><td>19.1</td><td>80.1</td></tr>
    <tr><td>Toronto Maple Leafs</td><td>54.0</td><td>101.0</td><td>25.0</td><td>81.0</td></tr>
  </table>
`;

const DEFAULT_POWER_HTML = `
  <table>
    <tr><th>Team</th><th>PP%</th><th>PK%</th><th>Power</th></tr>
    <tr><td>Montreal Canadiens</td><td>23.4</td><td>81.5</td><td>55.2</td></tr>
    <tr><td>Toronto Maple Leafs</td><td>27.6</td><td>82.1</td><td>59.1</td></tr>
  </table>
`;

const DEFAULT_GOALIES_HTML = `
  <table>
    <tr><th>Goalie</th><th>Team</th><th>GSaX</th></tr>
    <tr><td>Sam Montembeault</td><td>Montreal Canadiens</td><td>12.4</td></tr>
    <tr><td>Joseph Woll</td><td>Toronto Maple Leafs</td><td>9.1</td></tr>
  </table>
`;

const DEFAULT_GOALIES_CSV = [
  'name,team,situation,xGoals,goals',
  'Sam Montembeault,MTL,all,100,92',
  'Joseph Woll,TOR,all,95,90',
].join('\n');

const DEFAULT_SKATERS_CSV = [
  'name,team,situation,games_played,icetime,i_f_points,onice_xgoalsfor',
  'Nick Suzuki,MTL,all,10,200,12,8',
  'Mitch Marner,TOR,all,10,180,15,10',
].join('\n');

const DEFAULT_INJURIES_HTML = `
  <table>
    <tr><th>Team</th><th>Player</th><th>Status</th><th>Details</th></tr>
    <tr><td>Montreal Canadiens</td><td>Cole Caufield</td><td>DTD</td><td>Rest</td></tr>
  </table>
`;

const DEFAULT_INJURIES_CSV = [
  'playerName,teamCode,yahooInjuryDescription,playerInjuryStatus',
  'Cole Caufield,MTL,Upper body,IR-NR',
].join('\n');

const DEFAULT_ROTOWIRE_PAYLOAD = JSON.stringify([
  {
    hometeam: 'MTL',
    homePlayer: 'Sam Montembeault',
    homeStatus: 'confirmed',
    visitteam: 'TOR',
    visitPlayer: 'Joseph Woll',
    visitStatus: 'expected',
  },
]);

function createHttpsGetMock(resolver) {
  return jest.fn((url, options, callback) => {
    const responseFactory = typeof resolver === 'function' ? resolver : () => ({});
    const route = responseFactory(String(url), options || {});
    const request = new EventEmitter();

    process.nextTick(() => {
      if (!route) {
        request.emit('error', new Error(`No mock response configured for ${url}`));
        return;
      }

      if (route.error) {
        request.emit('error', route.error);
        return;
      }

      const response = new EventEmitter();
      response.statusCode = route.statusCode || 200;
      response.setEncoding = jest.fn();
      response.resume = jest.fn();

      callback(response);

      if (route.body != null) {
        response.emit('data', String(route.body));
      }
      response.emit('end');
    });

    return request;
  });
}

function defaultResolver(overrides = {}) {
  return (url) => {
    if (Object.prototype.hasOwnProperty.call(overrides, url)) {
      return overrides[url];
    }
    if (url.startsWith(ROTOWIRE_BASE)) {
      return overrides[ROTOWIRE_BASE] || { body: DEFAULT_ROTOWIRE_PAYLOAD };
    }
    if (url.includes('/seasonSummary/') && url.endsWith('/goalies.csv')) {
      return overrides.goaliesCsv || { body: DEFAULT_GOALIES_CSV };
    }
    if (url.includes('/seasonSummary/') && url.endsWith('/skaters.csv')) {
      return overrides.skatersCsv || { body: DEFAULT_SKATERS_CSV };
    }

    const defaults = {
      [MONEYPUCK_URLS.teams]: { body: DEFAULT_TEAMS_HTML },
      [MONEYPUCK_URLS.goalies]: { body: DEFAULT_GOALIES_HTML },
      [MONEYPUCK_URLS.stats]: { body: DEFAULT_STATS_HTML },
      [MONEYPUCK_URLS.injuries]: { body: DEFAULT_INJURIES_HTML },
      [MONEYPUCK_URLS.injuriesCsv]: { body: DEFAULT_INJURIES_CSV },
      [MONEYPUCK_URLS.power]: { body: DEFAULT_POWER_HTML },
    };

    return defaults[url];
  };
}

function loadMoneypuck(overrides = {}) {
  jest.resetModules();

  const httpsGetMock = createHttpsGetMock(defaultResolver(overrides));
  jest.doMock('https', () => ({
    get: httpsGetMock,
  }));

  const moneypuck = require('../moneypuck');
  return { moneypuck, httpsGetMock };
}

async function fetchSnapshot(overrides = {}) {
  const { moneypuck, httpsGetMock } = loadMoneypuck(overrides);
  const snapshot = await moneypuck.fetchMoneyPuckSnapshot({
    cachePath: null,
    ttlMs: 0,
  });
  return { snapshot, httpsGetMock };
}

afterEach(() => {
  jest.resetModules();
  jest.unmock('https');
  jest.clearAllMocks();
});

describe('moneypuck fetch and normalization coverage', () => {
  test('parses and merges MoneyPuck sources into a single snapshot', async () => {
    const { snapshot, httpsGetMock } = await fetchSnapshot();

    expect(httpsGetMock).toHaveBeenCalled();
    expect(snapshot.error).toBeUndefined();
    expect(snapshot.teams['Montreal Canadiens']).toEqual({
      xgf_pct: 52.4,
      pdo: 100.8,
      pp_pct: 23.4,
      pk_pct: 81.5,
      power_index: 55.2,
    });
    expect(snapshot.goalies['Montreal Canadiens']).toEqual({
      gsax: 12.4,
      source: 'moneypuck',
    });
    expect(snapshot.rotowire_goalies['Montreal Canadiens']).toEqual({
      name: 'Sam Montembeault',
      status: 'CONFIRMED',
      source: 'rotowire',
    });
    expect(Object.keys(snapshot.rotowire_goalies_by_date)).toHaveLength(3);
    expect(snapshot.injuries['Montreal Canadiens']).toEqual([
      {
        player: 'Cole Caufield',
        status: 'IR',
        detail: 'Upper body',
      },
    ]);
    expect(snapshot.skaters.league_avg_toi_per_game).toBe(19);
    expect(snapshot.skaters.by_team['Montreal Canadiens']['nick suzuki']).toEqual({
      player: 'Nick Suzuki',
      toi_per_game: 20,
      points_per_game: 1.2,
      onice_xgf_for_per_game: 0.8,
      impact: 1.053,
    });
  });

  test('falls back to goalie CSV when goalie HTML lacks usable GSAX values', async () => {
    const goalieHtmlWithoutGsax = `
      <table>
        <tr><th>Goalie</th><th>Team</th><th>GSaX</th></tr>
        <tr><td>Sam Montembeault</td><td>Montreal Canadiens</td><td></td></tr>
      </table>
    `;

    const { snapshot } = await fetchSnapshot({
      [MONEYPUCK_URLS.goalies]: { body: goalieHtmlWithoutGsax },
      goaliesCsv: {
        body: [
          'name,team,situation,xGoals,goals',
          'Sam Montembeault,MTL,all,100,90',
          'Joseph Woll,TOR,all,95,92',
        ].join('\n'),
      },
    });

    expect(snapshot.goalies['Montreal Canadiens']).toEqual({
      gsax: 10,
      source: 'moneypuck-csv',
    });
    expect(snapshot.goalies['Toronto Maple Leafs']).toEqual({
      gsax: 3,
      source: 'moneypuck-csv',
    });
  });

  test('normalizes skater rates and clamps impact scores', async () => {
    const { snapshot } = await fetchSnapshot({
      skatersCsv: {
        body: [
          'name,team,situation,games_played,icetime,i_f_points,onice_xgoalsfor',
          'Nick Suzuki,MTL,all,1,110,2,1',
          'Mitch Marner,TOR,all,1,10,1,0.5',
          'John Tavares,TOR,all,1,10,0,0.1',
        ].join('\n'),
      },
    });

    expect(snapshot.skaters.league_avg_toi_per_game).toBe(43.333);
    expect(snapshot.skaters.by_team['Montreal Canadiens']['nick suzuki']).toEqual({
      player: 'Nick Suzuki',
      toi_per_game: 110,
      points_per_game: 2,
      onice_xgf_for_per_game: 1,
      impact: 2.5,
    });
    expect(snapshot.skaters.by_team['Toronto Maple Leafs']['mitch marner']).toEqual({
      player: 'Mitch Marner',
      toi_per_game: 10,
      points_per_game: 1,
      onice_xgf_for_per_game: 0.5,
      impact: 0.5,
    });
  });

  test('keeps enrichment output shape stable when snapshot fields are missing', async () => {
    const { moneypuck } = loadMoneypuck();

    const enriched = await moneypuck.enrichOddsSnapshotWithMoneyPuck(
      {
        home_team: 'Montreal Canadiens',
        away_team: 'Toronto Maple Leafs',
        game_time_utc: '2026-03-11T23:30:00Z',
        raw_data: JSON.stringify({}),
      },
      {
        snapshot: {
          fetched_at: '2026-03-11T12:00:00Z',
          teams: {
            'Montreal Canadiens': {
              xgf_pct: 52.4,
            },
          },
          goalies: {},
          injuries: {},
          rotowire_goalies: {},
          rotowire_goalies_by_date: {},
          skaters: {
            league_avg_toi_per_game: null,
            by_team: {},
          },
        },
      },
    );

    const raw = JSON.parse(enriched.raw_data);
    expect(raw.teams.home.xgf_pct).toBe(52.4);
    expect(raw.teams.away.xgf_pct).toBeNull();
    expect(raw.goalie.home.gsax).toBeNull();
    expect(raw.goalie.away.gsax).toBeNull();
    expect(raw.goalie_home_status).toBeNull();
    expect(raw.goalie_away_status).toBeNull();
    expect(raw.injury_status.home).toEqual([]);
    expect(raw.injury_status.away).toEqual([]);
    expect(raw.injury_impact.home).toEqual({
      league_avg_toi_per_game: null,
      players: {},
    });
    expect(raw.injury_impact.away).toEqual({
      league_avg_toi_per_game: null,
      players: {},
    });
    expect(raw.rotowire_resolution.home.fallback_reason_codes).toEqual([
      'ROTOWIRE_DATE_WINDOW_MISS',
      'ROTOWIRE_SOURCE_MISS',
    ]);
    expect(raw.moneypuck).toEqual({
      fetched_at: '2026-03-11T12:00:00Z',
      source: 'moneypuck',
      team_keys: {
        home: 'Montreal Canadiens',
        away: 'Toronto Maple Leafs',
      },
    });
  });

  test('returns a fallback snapshot with an error when a required fetch fails', async () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

    try {
      const { snapshot } = await fetchSnapshot({
        [MONEYPUCK_URLS.teams]: {
          error: new Error('network fail teams'),
        },
      });

      expect(snapshot.teams).toEqual({});
      expect(snapshot.goalies).toEqual({});
      expect(snapshot.injuries).toEqual({});
      expect(snapshot.error).toBe('network fail teams');
      expect(snapshot.fetched_at).toEqual(expect.any(String));
      expect(warnSpy).toHaveBeenCalledWith(
        '[MoneyPuck] Fetch failed: network fail teams',
      );
    } finally {
      warnSpy.mockRestore();
    }
  });
});
