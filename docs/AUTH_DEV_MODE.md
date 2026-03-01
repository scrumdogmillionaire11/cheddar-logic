# Auth Development Mode

## Quick Setup: Skip Login Entirely (Recommended for Local Dev)

To bypass authentication during local development, add this to your `.env.local`:

```bash
# DEV ONLY: Bypass auth completely - no magic links needed!
DEV_BYPASS_AUTH_EMAIL=dev@example.com
NEXT_PUBLIC_DEV_BYPASS_ENABLED=true
```

**Effect:**
- You can access `/cards` and `/fpl` directly without logging in
- No need to click magic links or check console logs
- User will be treated as an ADMIN with ACTIVE subscription
- Only works in development mode (`NODE_ENV !== 'production'`)

**Restart your dev server after adding these env vars:**
```bash
npm run dev
```

---

## What Was Fixed

### 1. **Token TTL Was Too Short** ❌ → ✅
- **Before:** Access tokens expired in 15 minutes → constant login loops
- **After:** Access tokens last 24 hours → smooth experience
- **File:** [env.example](../env.example)

### 2. **AuthRefresher Was Too Aggressive** ❌ → ✅
- **Before:** Any refresh failure immediately redirected to login
- **After:** Retries 3 times before redirecting, handles network errors gracefully
- **File:** [auth-refresher.tsx](../web/src/components/auth-refresher.tsx)

### 3. **Magic Link Double-Click Issue** ❌ → ✅
- **Before:** Clicking same link twice caused "already used" error
- **After:** Checks if you already have a valid session before consuming the link
- **File:** [auth/verify/route.ts](../web/src/app/auth/verify/route.ts)

### 4. **Dev Bypass Mode** ✨ NEW
- Skip authentication entirely during local development
- No more magic link email checking
- Just set `DEV_BYPASS_AUTH_EMAIL` and go

---

## Troubleshooting

### "Subscription Required" after clicking magic link?

**Cause:** Your existing user account was created before the auto-COMPED dev fix was applied.

**Quick Fix - Grant yourself access:**

```bash
# Option 1: Grant COMPED flag (simplest)
node -e "const db=require('./packages/data/src/db.js');(async()=>{await db.initDb();const c=db.getDatabase();c.prepare('UPDATE users SET flags=? WHERE email=?').run('[\"COMPED\"]','YOUR_EMAIL@example.com');console.log('✅ Granted COMPED access');})();"

# Option 2: Make yourself ADMIN
node -e "const db=require('./packages/data/src/db.js');(async()=>{await db.initDb();const c=db.getDatabase();c.prepare('UPDATE users SET role=? WHERE email=?').run('ADMIN','YOUR_EMAIL@example.com');console.log('✅ Granted ADMIN role');})();"

# Then refresh your browser
```

**OR use dev bypass instead (no DB changes needed):**

```bash
# Add to .env.local
DEV_BYPASS_AUTH_EMAIL=your-email@example.com
NEXT_PUBLIC_DEV_BYPASS_ENABLED=true

# Restart dev server
npm run dev
```

### Still seeing login loops?

1. **Check your `.env.local` has the correct TTL values:**
   ```bash
   AUTH_ACCESS_TTL_MS=86400000     # 24 hours (not 900000!)
   AUTH_REFRESH_TTL_MS=2592000000  # 30 days
   ```

2. **Clear your cookies:**
   - Open DevTools → Application → Cookies
   - Delete `cheddar_access_token` and `cheddar_refresh_token`
   - Refresh the page

3. **Enable dev bypass (easiest):**
   ```bash
   # Add to .env.local
   DEV_BYPASS_AUTH_EMAIL=your-email@example.com
   NEXT_PUBLIC_DEV_BYPASS_ENABLED=true
   ```

4. **Check the database:**
   ```bash
   # Sessions should still be valid
   node -e "const db=require('./packages/data/src/db.js');(async()=>{await db.initDb();const c=db.getDatabase();console.table(c.prepare('SELECT id, user_id, expires_at, revoked_at FROM sessions ORDER BY created_at DESC LIMIT 5').all());})();"
   ```

### Magic link not working?

If you're still using magic links instead of dev bypass:

1. **Check the console logs** for the magic link URL (only in dev mode)
2. **Don't click the link twice** - it's single-use (though we now handle this better)
3. **Check link hasn't expired** - links expire after 15 minutes
4. **Use dev bypass instead** - much easier for local dev!

---

## Production Mode

None of these dev shortcuts work in production:
- `DEV_BYPASS_AUTH_EMAIL` is ignored
- Magic links are NOT printed to console
- Full security is enforced

In production, users must:
1. Request a magic link via email
2. Click the link to authenticate
3. Session lasts 30 days with automatic refresh
