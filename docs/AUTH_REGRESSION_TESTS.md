# Auth Regression Tests Documentation

## Problem Statement

**Issue**: Users experiencing unexpected auth failures where:
- Login works initially but users get signed out 5 minutes later
- Sessions don't persist across requests
- Users forced to log in again despite having valid refresh tokens
- Database state inconsistent between route handlers

**Root Cause**: Database persistence layer using SQL.js in-memory with file backing. Without proper save/close cycles, writes weren't persisting to disk, causing sessions to vanish on Next.js hot reload or server restart.

## Test Coverage

### **auth-persistence.test.js** (8 tests)

Tests that specifically prevent database persistence regressions:

1. **Session persists to disk after creation**
   - Creates user + subscription + session
   - Closes database
   - Reopens database from disk
   - Verifies all data persisted

2. **Magic link verification creates persistent session**
   - Simulates full magic link flow
   - Creates user, marks link as used, creates session
   - Verifies persistence across DB connections

3. **Access token validation works after session creation**
   - Creates session, generates access token
   - Closes DB, reopens in new connection
   - Validates token still works

4. **Refresh token survives database reload**
   - Creates session with refresh token
   - Simulates refresh request with new DB connection
   - Verifies refresh token lookup succeeds

5. **Multiple sessions for same user persist independently**
   - Creates 3 concurrent sessions (desktop/mobile/tablet)
   - Revokes one session
   - Verifies other sessions remain active after reload

6. **Session expiry check survives database reload**
   - Creates expired and valid sessions
   - Reloads database
   - Verifies expiry timestamps still enforced

7. **User role change persists and affects entitlement**
   - Creates FREE_ACCOUNT user
   - Upgrades to ADMIN
   - Verifies entitlement change persists

8. **Large batch of users persists correctly**
   - Creates 50 users in batch
   - Verifies all users queryable after reload

### **auth-cookie-regression.test.js** (6 tests)

Tests cookie handling and token lifecycle:

1. **Cookies contain correct TTL values**
   - Access token: 24 hours (86400s)
   - Refresh token: 30 days (2592000s)
   - Verifies httpOnly, sameSite, secure flags

2. **Access token includes session ID for validation**
   - Verifies JWT payload contains `sub` (user ID) and `sid` (session ID)

3. **Cookie clearing sets maxAge to 0**
   - Verifies logout properly clears cookies

4. **Refresh endpoint updates access token without losing session**
   - Verifies refresh uses SAME session ID
   - Checks last_seen_at updates

5. **Concurrent cookie reads from multiple routes work**
   - Simulates parallel requests
   - Verifies no race conditions

6. **AuthRefresher does not cause logout loop**
   - Simulates 5 consecutive refresh attempts
   - Verifies session not revoked by refresh activity

## Running Tests

```bash
# Run all auth tests (includes persistence + session + entitlement)
./scripts/test-auth.sh

# Run just persistence tests
npm --prefix packages/data test -- auth-persistence.test.js

# Run just cookie tests
npm --prefix web test -- auth-cookie-regression.test.js
```

## What These Tests Catch

✅ Database writes not persisting to disk  
✅ Sessions vanishing on server restart  
✅ Cookies with incorrect TTL values  
✅ Access tokens missing session ID  
✅ Refresh endpoint creating new sessions instead of reusing  
✅ Multiple DB connections reading stale data  
✅ AuthRefresher inadvertently logging users out  

## Key Assertions

Each test follows this pattern:
1. **Write operation** (create user/session/etc)
2. **Close database** (simulates process boundary)
3. **Reopen database** (new connection, reads from disk)
4. **Verify data** (ensures persistence worked)

This matches the real-world scenario where Next.js route handlers each get fresh DB connections.

## Test Output (Expected)

```
Auth Persistence Regression Tests
  ✓ REGRESSION: session persists to disk after creation (94 ms)
  ✓ REGRESSION: magic link verification creates persistent session (34 ms)
  ✓ REGRESSION: access token validation works after session creation (17 ms)
  ✓ REGRESSION: refresh token survives database reload (19 ms)
  ✓ REGRESSION: multiple sessions for same user persist independently (24 ms)
  ✓ REGRESSION: session expiry check survives database reload (14 ms)
  ✓ REGRESSION: user role change persists and affects entitlement (12 ms)
  ✓ REGRESSION: large batch of users persists correctly (67 ms)

Test Suites: 1 passed, 1 total
Tests:       8 passed, 8 total
```

## Next Steps

These tests should be run:
- **Before every PR merge** (part of CI/CD)
- **After any database layer changes**
- **When investigating auth issues**

Add additional regression tests as new edge cases are discovered.
