import assert from 'node:assert/strict';
import { getClientIp, resolveClientIp } from '../lib/api-security/rate-limiter.ts';

function restoreEnv(snapshot) {
  process.env.NODE_ENV = snapshot.NODE_ENV;
  process.env.TRUSTED_PROXY_IPS = snapshot.TRUSTED_PROXY_IPS;
}

async function runTests() {
  let passed = 0;
  let failed = 0;

  const envSnapshot = {
    NODE_ENV: process.env.NODE_ENV,
    TRUSTED_PROXY_IPS: process.env.TRUSTED_PROXY_IPS,
  };

  function test(name, fn) {
    try {
      fn();
      console.log(`  PASS ${name}`);
      passed += 1;
    } catch (error) {
      console.error(`  FAIL ${name}`);
      console.error(error);
      failed += 1;
    }
  }

  console.log('Running trusted proxy rate limiter tests');

  test('uses forwarded client IP only when proxy is trusted', () => {
    process.env.TRUSTED_PROXY_IPS = '10.0.0.5';
    const req = new Request('http://localhost/api/cards', {
      headers: {
        'x-real-ip': '10.0.0.5',
        'x-forwarded-for': '203.0.113.10, 10.0.0.5',
        'user-agent': 'wi-1125-test-agent',
      },
    });

    assert.equal(getClientIp(req), '203.0.113.10');
    assert.equal(resolveClientIp(req).forwardedChainRejected, false);
  });

  test('rejects forwarded chain from untrusted proxy and avoids spoofed allowlisted IP', () => {
    process.env.TRUSTED_PROXY_IPS = '10.0.0.5';
    const req = new Request('http://localhost/api/cards', {
      headers: {
        'x-real-ip': '198.51.100.20',
        'x-forwarded-for': '203.0.113.10, 198.51.100.20',
        'user-agent': 'wi-1125-test-agent',
      },
    });

    const resolved = resolveClientIp(req);
    assert.equal(resolved.forwardedChainRejected, true);
    assert.equal(resolved.clientIp.startsWith('unknown:untrusted-forwarded-chain:'), true);
    assert.notEqual(resolved.clientIp, '203.0.113.10');
  });

  test('falls back to direct connecting header when no forwarded chain exists', () => {
    delete process.env.TRUSTED_PROXY_IPS;
    const req = new Request('http://localhost/api/cards', {
      headers: {
        'cf-connecting-ip': '203.0.113.55',
        'user-agent': 'wi-1125-test-agent',
      },
    });

    assert.equal(getClientIp(req), '203.0.113.55');
  });

  restoreEnv(envSnapshot);

  console.log(`\nResults: ${passed} passed, ${failed} failed`);
  if (failed > 0) {
    process.exit(1);
  }

  process.exit(0);
}

runTests().catch((error) => {
  console.error(error);
  process.exit(1);
});
