const ORIGINAL_ENV = process.env;

function setEnv(overrides = {}) {
  process.env = { ...ORIGINAL_ENV };
  delete process.env.NODE_ENV;
  delete process.env.ALLOW_DOTENV_LOCAL;

  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined || value === null) {
      delete process.env[key];
    } else {
      process.env[key] = String(value);
    }
  }
}

function mockDotenv(configImpl) {
  const config = jest.fn(configImpl || (() => ({ parsed: { OK: '1' } })));
  jest.doMock('dotenv', () => ({ config }));
  return config;
}

function loadModule(modulePath) {
  let loaded;
  jest.isolateModules(() => {
    loaded = require(modulePath);
  });
  return loaded;
}

afterEach(() => {
  jest.resetModules();
  jest.clearAllMocks();
  jest.dontMock('dotenv');
  process.env = { ...ORIGINAL_ENV };
});

describe('dotenv loading guard', () => {
  test.each(['production', 'staging', 'preprod'])(
    'skips dotenv in %s by default',
    (env) => {
      setEnv({ NODE_ENV: env, ALLOW_DOTENV_LOCAL: undefined });
      const config = mockDotenv();

      loadModule('../jobs/report_settlement_health');

      expect(config).not.toHaveBeenCalled();
    },
  );

  test('allows dotenv in production-like runtime only when explicitly enabled', () => {
    setEnv({ NODE_ENV: 'production', ALLOW_DOTENV_LOCAL: 'true' });
    const config = mockDotenv();

    loadModule('../jobs/report_settlement_health');

    expect(config).toHaveBeenCalledTimes(1);
    expect(config).toHaveBeenCalledWith(expect.objectContaining({ override: false }));
  });

  test.each(['development', 'test'])('allows dotenv in %s', (env) => {
    setEnv({ NODE_ENV: env, ALLOW_DOTENV_LOCAL: undefined });
    const config = mockDotenv();

    loadModule('../jobs/report_settlement_health');

    expect(config).toHaveBeenCalledTimes(1);
    expect(config).toHaveBeenCalledWith(expect.objectContaining({ override: false }));
  });

  test('does not overwrite explicit process env values', () => {
    setEnv({ NODE_ENV: 'development', EXPLICIT_VALUE: 'from-process' });
    const config = mockDotenv((options) => {
      if (options.override) {
        process.env.EXPLICIT_VALUE = 'from-dotenv';
      }
      return { parsed: { EXPLICIT_VALUE: 'from-dotenv' } };
    });

    loadModule('../jobs/report_settlement_health');

    expect(config).toHaveBeenCalledWith(expect.objectContaining({ override: false }));
    expect(process.env.EXPLICIT_VALUE).toBe('from-process');
  });

  test('requiring check_pipeline_health does not trigger dotenv in production-like mode', () => {
    setEnv({ NODE_ENV: 'production', ALLOW_DOTENV_LOCAL: undefined });
    const config = mockDotenv();

    loadModule('../jobs/check_pipeline_health');

    expect(config).not.toHaveBeenCalled();
  });
});
