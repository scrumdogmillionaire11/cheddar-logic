import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  FileRateLimitBackend,
  RateLimiter,
  getClientIp,
} from '../lib/api-security/rate-limiter.ts';

const FIXED_NOW = 1_800_000_000_000;
const WINDOW_MS = 60_000;
const RATE_LIMITER_MODULE_URL = new URL(
  '../lib/api-security/rate-limiter.ts',
  import.meta.url,
).href;

async function withTempState(testFn) {
  const tempDir = await mkdtemp(join(tmpdir(), 'wi-1132-rate-limit-'));
  const stateFilePath = join(tempDir, 'rate-limiter-state.json');

  try {
    await testFn(stateFilePath);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

function runProcessHit(stateFilePath, identifier) {
  const script = `
    import { FileRateLimitBackend, RateLimiter } from ${JSON.stringify(RATE_LIMITER_MODULE_URL)};

    const limiter = new RateLimiter(2, ${WINDOW_MS}, {
      backend: new FileRateLimitBackend(process.env.RATE_LIMIT_TEST_STATE_FILE),
      now: () => ${FIXED_NOW},
    });
    const result = limiter.isAllowed(process.env.RATE_LIMIT_TEST_ID);
    console.log(JSON.stringify(result));
  `;

  const output = execFileSync(process.execPath, ['--input-type=module', '--eval', script], {
    encoding: 'utf8',
    env: {
      ...process.env,
      RATE_LIMIT_TEST_ID: identifier,
      RATE_LIMIT_TEST_STATE_FILE: stateFilePath,
    },
  });

  return JSON.parse(output);
}

function makeFallbackRequest(headers) {
  return new Request('http://localhost/api/cards', {
    headers: {
      'user-agent': 'wi-1132-contract-agent',
      accept: 'application/json',
      ...headers,
    },
  });
}

async function runTests() {
  let passed = 0;
  let failed = 0;

  async function test(name, fn) {
    try {
      await fn();
      console.log(`  PASS ${name}`);
      passed += 1;
    } catch (error) {
      console.error(`  FAIL ${name}`);
      console.error(error);
      failed += 1;
    }
  }

  console.log('Running distributed rate limiter contract tests');

  await test('multiple Node processes share quota through distributed state', async () => {
    await withTempState(async (stateFilePath) => {
      const identifier = 'process-boundary-client';

      const first = runProcessHit(stateFilePath, identifier);
      const second = runProcessHit(stateFilePath, identifier);
      const third = runProcessHit(stateFilePath, identifier);

      assert.equal(first.allowed, true);
      assert.equal(first.remaining, 1);
      assert.equal(second.allowed, true);
      assert.equal(second.remaining, 0);
      assert.equal(third.allowed, false);
      assert.equal(third.remaining, 0);
      assert.equal(third.resetTime, FIXED_NOW + WINDOW_MS);
      assert.equal(third.retryAfterSeconds, 60);
    });
  });

  await test('fallback identity does not collapse same-user-agent clients into one bucket', async () => {
    await withTempState(async (stateFilePath) => {
      const limiter = new RateLimiter(1, WINDOW_MS, {
        stateFilePath,
        now: () => FIXED_NOW,
      });
      const firstRequest = makeFallbackRequest({
        'accept-language': 'en-US,en;q=0.9',
        'sec-ch-ua-platform': '"macOS"',
      });
      const secondRequest = makeFallbackRequest({
        'accept-language': 'fr-CA,fr;q=0.9',
        'sec-ch-ua-platform': '"Windows"',
      });

      const firstIdentity = getClientIp(firstRequest);
      const secondIdentity = getClientIp(secondRequest);

      assert.match(firstIdentity, /^unknown:missing-forwarding-context:/);
      assert.match(secondIdentity, /^unknown:missing-forwarding-context:/);
      assert.notEqual(firstIdentity, secondIdentity);
      assert.equal(limiter.isAllowed(firstIdentity).allowed, true);
      assert.equal(limiter.isAllowed(secondIdentity).allowed, true);
    });
  });

  await test('exhausted identity returns deterministic deny metadata', async () => {
    await withTempState(async (stateFilePath) => {
      const limiter = new RateLimiter(1, WINDOW_MS, {
        backend: new FileRateLimitBackend(stateFilePath),
        now: () => FIXED_NOW,
      });

      assert.equal(limiter.isAllowed('deterministic-deny-client').allowed, true);
      const denied = limiter.isAllowed('deterministic-deny-client');

      assert.deepEqual(denied, {
        allowed: false,
        remaining: 0,
        resetTime: FIXED_NOW + WINDOW_MS,
        retryAfterSeconds: 60,
      });
    });
  });

  console.log(`\nResults: ${passed} passed, ${failed} failed`);
  if (failed > 0) {
    process.exit(1);
  }
}

runTests().catch((error) => {
  console.error(error);
  process.exit(1);
});
