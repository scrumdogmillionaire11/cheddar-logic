import assert from 'node:assert/strict';
import { checkTokenRouteAllowlist } from '../lib/api-security/token-route-allowlist.ts';

function restoreEnv(snapshot) {
  process.env.NODE_ENV = snapshot.NODE_ENV;
  process.env.TRUSTED_PROXY_IPS = snapshot.TRUSTED_PROXY_IPS;
  process.env.TOKEN_ROUTE_ALLOWED_IPS = snapshot.TOKEN_ROUTE_ALLOWED_IPS;
}

function makeRequest(headers = {}) {
  return new Request('http://localhost:3000/api/auth/token', {
    method: 'GET',
    headers,
  });
}

async function runTests() {
  let passed = 0;
  let failed = 0;

  const envSnapshot = {
    NODE_ENV: process.env.NODE_ENV,
    TRUSTED_PROXY_IPS: process.env.TRUSTED_PROXY_IPS,
    TOKEN_ROUTE_ALLOWED_IPS: process.env.TOKEN_ROUTE_ALLOWED_IPS,
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

  console.log('Running token route allowlist tests');

  test('denies forged forwarded header when proxy is untrusted', () => {
    process.env.NODE_ENV = 'production';
    process.env.TRUSTED_PROXY_IPS = '10.0.0.5';
    process.env.TOKEN_ROUTE_ALLOWED_IPS = '203.0.113.10';

    const request = makeRequest({
      'x-real-ip': '198.51.100.20',
      'x-forwarded-for': '203.0.113.10, 198.51.100.20',
      'user-agent': 'wi-1125-test-agent',
    });

    const response = checkTokenRouteAllowlist(request);
    assert.ok(response, 'expected a forbidden response');
    assert.equal(response.status, 403);
  });

  test('allows request when forwarded chain is trusted and client IP is allowlisted', () => {
    process.env.NODE_ENV = 'production';
    process.env.TRUSTED_PROXY_IPS = '10.0.0.5';
    process.env.TOKEN_ROUTE_ALLOWED_IPS = '203.0.113.10';

    const request = makeRequest({
      'x-real-ip': '10.0.0.5',
      'x-forwarded-for': '203.0.113.10, 10.0.0.5',
      'user-agent': 'wi-1125-test-agent',
    });

    const response = checkTokenRouteAllowlist(request);
    assert.equal(response, null);
  });

  test('bypasses allowlist only in development mode', () => {
    process.env.NODE_ENV = 'development';
    process.env.TRUSTED_PROXY_IPS = '10.0.0.5';
    process.env.TOKEN_ROUTE_ALLOWED_IPS = '203.0.113.10';

    const request = makeRequest({
      'x-real-ip': '198.51.100.20',
      'x-forwarded-for': '203.0.113.10, 198.51.100.20',
      'user-agent': 'wi-1125-test-agent',
    });

    const response = checkTokenRouteAllowlist(request);
    assert.equal(response, null);
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
