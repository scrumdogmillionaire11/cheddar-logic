import assert from 'node:assert/strict';
import test from 'node:test';

import { isWelcomeHomeCardType } from './welcome-home';

test('isWelcomeHomeCardType handles canonical + legacy alias', () => {
  assert.equal(isWelcomeHomeCardType('welcome-home'), true);
  assert.equal(isWelcomeHomeCardType('welcome-home-v2'), true);
  assert.equal(isWelcomeHomeCardType('WELCOME-HOME-V2'), true);
  assert.equal(isWelcomeHomeCardType('  welcome-home  '), true);
  assert.equal(isWelcomeHomeCardType('nhl-totals-call'), false);
  assert.equal(isWelcomeHomeCardType(undefined), false);
});
