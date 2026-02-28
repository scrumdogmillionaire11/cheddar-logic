'use strict';

const {
  RESOURCE,
  USER_ROLE,
  USER_STATUS,
  SUBSCRIPTION_STATUS,
  createAccessToken,
  hashTokenHmac,
  hasEntitlement,
  timingSafeEqualHex,
  verifySignedPayload,
} = require('../index');

describe('auth helpers', () => {
  test('hashTokenHmac + timingSafeEqualHex validate matching token hash', () => {
    const token = 'abc123';
    const hash = hashTokenHmac(token);

    expect(timingSafeEqualHex(hash, hashTokenHmac(token))).toBe(true);
    expect(timingSafeEqualHex(hash, hashTokenHmac('different-token'))).toBe(false);
  });

  test('hasEntitlement enforces suspension before admin override', () => {
    const user = {
      role: USER_ROLE.ADMIN,
      user_status: USER_STATUS.SUSPENDED,
      flags: JSON.stringify(['COMPED']),
      subscription_status: SUBSCRIPTION_STATUS.ACTIVE,
      current_period_end: '2099-01-01T00:00:00.000Z',
    };

    expect(hasEntitlement(user, RESOURCE.CHEDDAR_BOARD)).toBe(false);
    expect(hasEntitlement(user, RESOURCE.ADMIN_PANEL)).toBe(false);
  });

  test('hasEntitlement grants active ambassador and denies expired ambassador', () => {
    const activeAmbassador = {
      role: USER_ROLE.FREE_ACCOUNT,
      user_status: USER_STATUS.ACTIVE,
      flags: JSON.stringify(['AMBASSADOR']),
      ambassador_expires_at: '2099-01-01T00:00:00.000Z',
    };

    const expiredAmbassador = {
      role: USER_ROLE.FREE_ACCOUNT,
      user_status: USER_STATUS.ACTIVE,
      flags: JSON.stringify(['AMBASSADOR']),
      ambassador_expires_at: '2020-01-01T00:00:00.000Z',
    };

    expect(hasEntitlement(activeAmbassador, RESOURCE.CHEDDAR_BOARD)).toBe(true);
    expect(hasEntitlement(activeAmbassador, RESOURCE.FPL_SAGE)).toBe(true);
    expect(hasEntitlement(expiredAmbassador, RESOURCE.CHEDDAR_BOARD)).toBe(false);
  });

  test('access token signing verifies and expires correctly', async () => {
    const token = createAccessToken({
      userId: 'user-1',
      role: USER_ROLE.FREE_ACCOUNT,
      flags: [],
      sessionId: 'session-1',
    }, 25);

    const verified = verifySignedPayload(token);
    expect(verified).not.toBeNull();
    expect(verified.sub).toBe('user-1');

    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(verifySignedPayload(token)).toBeNull();
  });

  test('access token includes session id for validation', () => {
    const token = createAccessToken({
      userId: 'user-abc',
      role: USER_ROLE.ADMIN,
      flags: ['COMPED'],
      sessionId: 'session-xyz',
    }, 60000);

    const payload = verifySignedPayload(token);
    expect(payload.sub).toBe('user-abc');
    expect(payload.sid).toBe('session-xyz');
  });

  test('hasEntitlement grants ADMIN access to all resources', () => {
    const admin = {
      role: USER_ROLE.ADMIN,
      user_status: USER_STATUS.ACTIVE,
      flags: JSON.stringify([]),
    };

    expect(hasEntitlement(admin, RESOURCE.CHEDDAR_BOARD)).toBe(true);
    expect(hasEntitlement(admin, RESOURCE.FPL_SAGE)).toBe(true);
    expect(hasEntitlement(admin, RESOURCE.ADMIN_PANEL)).toBe(true);
  });

  test('hasEntitlement denies FREE_ACCOUNT without subscription', () => {
    const freeUser = {
      role: USER_ROLE.FREE_ACCOUNT,
      user_status: USER_STATUS.ACTIVE,
      flags: JSON.stringify([]),
      subscription_status: SUBSCRIPTION_STATUS.NONE,
    };

    expect(hasEntitlement(freeUser, RESOURCE.CHEDDAR_BOARD)).toBe(false);
    expect(hasEntitlement(freeUser, RESOURCE.FPL_SAGE)).toBe(false);
  });

  test('hasEntitlement grants access with ACTIVE subscription and valid period', () => {
    const subscribedUser = {
      role: USER_ROLE.PAID,
      user_status: USER_STATUS.ACTIVE,
      flags: JSON.stringify([]),
      subscription_status: SUBSCRIPTION_STATUS.ACTIVE,
      current_period_end: '2099-12-31T23:59:59.000Z',
    };

    expect(hasEntitlement(subscribedUser, RESOURCE.CHEDDAR_BOARD)).toBe(true);
    expect(hasEntitlement(subscribedUser, RESOURCE.FPL_SAGE)).toBe(true);
  });

  test('hasEntitlement revokes access when subscription period expires', () => {
    const expiredSub = {
      role: USER_ROLE.PAID,
      user_status: USER_STATUS.ACTIVE,
      flags: JSON.stringify([]),
      subscription_status: SUBSCRIPTION_STATUS.ACTIVE,
      current_period_end: '2020-01-01T00:00:00.000Z',
    };

    expect(hasEntitlement(expiredSub, RESOURCE.CHEDDAR_BOARD)).toBe(false);
    expect(hasEntitlement(expiredSub, RESOURCE.FPL_SAGE)).toBe(false);
  });
});
