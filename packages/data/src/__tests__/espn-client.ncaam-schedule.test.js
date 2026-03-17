const EventEmitter = require('events');

jest.mock('https', () => ({
  get: jest.fn(),
}));

const https = require('https');
const { fetchTeamSchedule } = require('../espn-client');

function mockEspnResponse(body, statusCode = 200) {
  https.get.mockImplementationOnce((url, options, callback) => {
    const response = new EventEmitter();
    response.statusCode = statusCode;
    response.resume = jest.fn();

    process.nextTick(() => {
      callback(response);
      process.nextTick(() => {
        response.emit('data', JSON.stringify(body));
        response.emit('end');
      });
    });

    const request = new EventEmitter();
    request.destroy = jest.fn();
    request.on = jest.fn().mockReturnValue(request);
    return request;
  });
}

describe('fetchTeamSchedule NCAAM fallback', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('retries with seasontype=2 when default NCAAM schedule has no completed games', async () => {
    const futureOnlySchedule = {
      events: [
        {
          date: '2099-03-17T19:00:00Z',
          competitions: [
            {
              status: { type: { completed: false } },
              competitors: [],
            },
          ],
        },
      ],
    };

    const completedSchedule = {
      events: [
        {
          date: '2026-03-10T19:00:00Z',
          competitions: [
            {
              status: { type: { completed: true } },
              competitors: [
                { homeAway: 'home', team: { id: '2547' }, score: '70', winner: true },
                { homeAway: 'away', team: { id: '2900' }, score: '64', winner: false },
              ],
            },
          ],
        },
      ],
    };

    mockEspnResponse(futureOnlySchedule);
    mockEspnResponse(completedSchedule);

    const games = await fetchTeamSchedule(
      'basketball/mens-college-basketball',
      '2547',
      5,
    );

    expect(https.get).toHaveBeenCalledTimes(2);
    const secondUrl = https.get.mock.calls[1][0];
    expect(secondUrl).toContain('/basketball/mens-college-basketball/teams/2547/schedule?seasontype=2');
    expect(games).toHaveLength(1);
    expect(games[0]).toMatchObject({
      pointsFor: 70,
      pointsAgainst: 64,
      result: 'W',
    });
  });
});
