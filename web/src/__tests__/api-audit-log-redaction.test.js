import assert from 'node:assert/strict';
import auditLogger from '../lib/api-security/audit-logger.ts';
import { AuditEventType } from '../lib/api-security/event-types.ts';

async function runTests() {
  let passed = 0;
  let failed = 0;

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

  console.log('Running audit log redaction tests');
  auditLogger.clearAllEvents();

  test('redacts sensitive token and header values while preserving deny reason', () => {
    const event = auditLogger.logEvent(
      AuditEventType.SUSPICIOUS_REQUEST,
      '198.51.100.20',
      {
        endpoint: '/api/auth/token',
        method: 'GET',
        userAgent: 'wi-1125-test-agent',
        details: {
          reason: 'untrusted_forwarded_chain',
          authorization: 'Bearer super-secret-token',
          token: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.test.sig',
          nested: {
            apiKey: 'abc123',
            note: 'keep-this-visible',
          },
        },
      },
    );

    assert.equal(event.details.reason, 'untrusted_forwarded_chain');
    assert.equal(event.details.authorization, '[REDACTED]');
    assert.equal(event.details.token, '[REDACTED]');
    assert.equal(event.details.nested.apiKey, '[REDACTED]');
    assert.equal(event.details.nested.note, 'keep-this-visible');
  });

  test('redacts bearer-style values even when key is not explicitly sensitive', () => {
    const event = auditLogger.logEvent(
      AuditEventType.SUSPICIOUS_REQUEST,
      '198.51.100.21',
      {
        details: {
          context: 'Bearer this-should-be-hidden',
        },
      },
    );

    assert.equal(event.details.context, '[REDACTED]');
  });

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
