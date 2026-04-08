'use strict';
/**
 * Unit tests for axiosGetWithRetry — WI-0816
 *
 * Tests: transient retry, permanent error fast-fail, exhausted retries,
 * and warning log on each retry.
 */

jest.mock('axios');
const axios = require('axios');
const { axiosGetWithRetry } = require('../index.js');

const TEST_URL = 'https://api.the-odds-api.com/v4/sports/basketball_nba/odds';
const CONFIG = { params: { sport: 'NBA' }, timeout: 10000 };

function makeAxiosError(status, code) {
  const err = new Error(code ? `${code}` : `HTTP ${status}`);
  if (status) {
    err.response = { status };
  } else {
    err.code = code;
  }
  return err;
}

beforeEach(() => {
  jest.clearAllMocks();
  // Suppress console output during tests
  jest.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  console.warn.mockRestore();
});

describe('axiosGetWithRetry — WI-0816', () => {
  it('returns response immediately on first success', async () => {
    const mockResp = { data: [{ id: 'game-1' }], headers: {} };
    axios.get.mockResolvedValueOnce(mockResp);

    const result = await axiosGetWithRetry(TEST_URL, CONFIG);

    expect(result).toBe(mockResp);
    expect(axios.get).toHaveBeenCalledTimes(1);
  });

  it('retries on 503 twice then returns successful response', async () => {
    const err503 = makeAxiosError(503);
    const mockResp = { data: [{ id: 'game-1' }], headers: {} };
    axios.get
      .mockRejectedValueOnce(err503)
      .mockRejectedValueOnce(err503)
      .mockResolvedValueOnce(mockResp);

    // Patch setTimeout to resolve immediately
    jest.spyOn(global, 'setTimeout').mockImplementation((fn) => fn());

    const result = await axiosGetWithRetry(TEST_URL, CONFIG);

    expect(result).toBe(mockResp);
    expect(axios.get).toHaveBeenCalledTimes(3);
    expect(console.warn).toHaveBeenCalledTimes(2);
    expect(console.warn.mock.calls[0][0]).toMatch(/attempt 1\/3/);
    expect(console.warn.mock.calls[1][0]).toMatch(/attempt 2\/3/);

    global.setTimeout.mockRestore();
  });

  it('rethrows 401 immediately without any retry', async () => {
    const err401 = makeAxiosError(401);
    axios.get.mockRejectedValueOnce(err401);

    await expect(axiosGetWithRetry(TEST_URL, CONFIG)).rejects.toBe(err401);
    expect(axios.get).toHaveBeenCalledTimes(1);
    expect(console.warn).not.toHaveBeenCalled();
  });

  it('rethrows 402 immediately without any retry', async () => {
    const err402 = makeAxiosError(402);
    axios.get.mockRejectedValueOnce(err402);

    await expect(axiosGetWithRetry(TEST_URL, CONFIG)).rejects.toBe(err402);
    expect(axios.get).toHaveBeenCalledTimes(1);
  });

  it('rethrows 403 immediately without any retry', async () => {
    const err403 = makeAxiosError(403);
    axios.get.mockRejectedValueOnce(err403);

    await expect(axiosGetWithRetry(TEST_URL, CONFIG)).rejects.toBe(err403);
    expect(axios.get).toHaveBeenCalledTimes(1);
  });

  it('rethrows after maxRetries exhausted (default 2 retries = 3 attempts)', async () => {
    const err503 = makeAxiosError(503);
    axios.get.mockRejectedValue(err503);

    jest.spyOn(global, 'setTimeout').mockImplementation((fn) => fn());

    await expect(axiosGetWithRetry(TEST_URL, CONFIG)).rejects.toBe(err503);
    expect(axios.get).toHaveBeenCalledTimes(3); // attempts 0, 1, 2
    expect(console.warn).toHaveBeenCalledTimes(2); // warns on attempt 1 and 2

    global.setTimeout.mockRestore();
  });

  it('logs warning with attempt count and delay on each retry', async () => {
    const err503 = makeAxiosError(503);
    const mockResp = { data: [], headers: {} };
    axios.get
      .mockRejectedValueOnce(err503)
      .mockResolvedValueOnce(mockResp);

    jest.spyOn(global, 'setTimeout').mockImplementation((fn) => fn());

    await axiosGetWithRetry(TEST_URL, CONFIG);

    expect(console.warn).toHaveBeenCalledTimes(1);
    const [msg, meta] = console.warn.mock.calls[0];
    expect(msg).toMatch(/Transient error/);
    expect(msg).toMatch(/HTTP 503/);
    expect(msg).toMatch(/retrying in 1000ms/);
    expect(meta).toMatchObject({ url: TEST_URL });

    global.setTimeout.mockRestore();
  });

  it('rethrows network error (ECONNRESET) after retries', async () => {
    const connErr = makeAxiosError(null, 'ECONNRESET');
    axios.get.mockRejectedValue(connErr);

    jest.spyOn(global, 'setTimeout').mockImplementation((fn) => fn());

    await expect(axiosGetWithRetry(TEST_URL, CONFIG)).rejects.toBe(connErr);
    expect(axios.get).toHaveBeenCalledTimes(3);

    global.setTimeout.mockRestore();
  });
});
