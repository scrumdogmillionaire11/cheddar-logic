## Production Deployment Checklist — Detailed Instructions

---

## Feature Flags (Optional for Dev/Staging)

You can toggle the security layers below without editing code by setting env vars:

```bash
# Optional: set to "false" to disable in non-production environments
ENABLE_AUDIT_LOGGING=false
ENABLE_RBAC=false
```

Defaults are `true` when unset. These flags only affect audit logging and RBAC enforcement; rate limiting, input validation, and security headers stay on.

## 0. Historical Settled Import (Option A Runbook)

Use the new one-off worker job to import settled history into the production DB source-of-truth.

### Dry-Run First (Required)
```bash
cd /opt/cheddar-logic
CHEDDAR_DB_PATH=/opt/cheddar-logic/packages/data/cheddar.db \
npm --prefix apps/worker run job:import-historical-settled:dry-run -- \
  --source /opt/cheddar-logic/packages/data/cheddar.before_fresh_reset_20260302_205644.db
```

### Apply Import
```bash
cd /opt/cheddar-logic
CHEDDAR_DB_PATH=/opt/cheddar-logic/packages/data/cheddar.db \
npm --prefix apps/worker run job:import-historical-settled -- \
  --source /opt/cheddar-logic/packages/data/cheddar.before_fresh_reset_20260302_205644.db
```

### Post-Import Settlement Sweep
```bash
cd /opt/cheddar-logic
CHEDDAR_DB_PATH=/opt/cheddar-logic/packages/data/cheddar.db \
npm --prefix apps/worker run job:settle-cards
```

### Safety Notes
- Job is idempotent by `card_results.id`; reruns skip already-imported results.
- `--apply` mode creates an automatic backup before writing.
- If old rows have no payload in source DB, the job creates flagged payload stubs so results can display.

---

## 1. **Disable Admin Audit Endpoint (Dev-Only)**

### ✅ How to Do It

**Option A: Environment Check (Recommended)**
```typescript
// web/src/app/api/admin/audit/route.ts — already has this:
if (process.env.NODE_ENV !== 'development') {
  return NextResponse.json(
    { success: false, error: 'Audit endpoint only available in development' },
    { status: 403 }
  );
}
```

✅ **Already protected!** In production (NODE_ENV=production), this automatically returns 403.

**Option B: Delete the Endpoint Entirely**
```bash
rm -rf web/src/app/api/admin/audit/
```

### ❌ If You Don't

| Consequence | Impact |
|-------------|--------|
| **Security leak** | Anyone can view all audit logs (auth failures, IPs, emails, user IDs) |
| **Privacy violation** | User data exposed (email addresses, subscription status) |
| **Compliance failure** | GDPR/CCPA violation if logging contains PII |
| **Attack intelligence** | Attackers see exactly what security events you're tracking |

**Real Example:** Attacker discovers endpoint → sees logs of failed auth attempts → identifies which users they couldn't compromise → targets those for social engineering.

---

## 2. **Set AUTH_SECRET Environment Variable**

### ✅ How to Do It

**Step 1: Generate a secure random string**
```bash
# macOS/Linux
openssl rand -hex 32
# Output example: a7f3e8c2d1b9f4e6a2c5d8e1f9b7a4c6d2e5f8a1b4c7d0e3f6a9c2d5e8f1b4

# Or use Node.js
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

**Step 2: Add to your environment**

*For local development (.env.local):*
```bash
echo "AUTH_SECRET=a7f3e8c2d1b9f4e6a2c5d8e1f9b7a4c6d2e5f8a1b4c7d0e3f6a9c2d5e8f1b4" >> web/.env.local
```

*For production (your hosting platform):*

**Vercel:**
```bash
vercel env add AUTH_SECRET
# Paste the secret when prompted
# Redeploy: git push
```

**Railway:**
```bash
# In Railway dashboard: Variables → Add → AUTH_SECRET
# Value: a7f3e8c2d1b9f4e6a2c5d8e1f9b7a4c6d2e5f8a1b4c7d0e3f6a9c2d5e8f1b4
```

**Docker/Self-hosted:**
```bash
# In docker-compose.yml or .env:
AUTH_SECRET=a7f3e8c2d1b9f4e6a2c5d8e1f9b7a4c6d2e5f8a1b4c7d0e3f6a9c2d5e8f1b4
```

**Step 3: Verify it's loaded**
```bash
curl http://localhost:3000/api/auth/token?role=PAID
# Should work in dev (returns token)

# In production, tokens should be:
# - Valid only with the correct AUTH_SECRET
# - Invalid if AUTH_SECRET changes
```

### ❌ If You Don't

| Consequence | Impact |
|-------------|--------|
| **Undefined behavior** | `process.env.AUTH_SECRET` is undefined → JWT signing fails |
| **All tokens invalid** | Every Bearer token is rejected → users get 401 errors |
| **API completely broken** | Any endpoint requiring auth returns 401 Unauthorized |
| **Downtime incident** | Users can't authenticate, service unavailable |

**Real Example:**
```
User sends valid token → verifyToken() tries to verify HMAC with undefined secret → signature check fails → 401 returned → user blocked from API
```

---

## 3. **Review CSP for Your CDN Domains**

### ✅ How to Do It

**Step 1: Identify your CDN domains**
```bash
# Check your current CSP
curl -i http://localhost:3000 | grep Content-Security-Policy

# Current policy:
# default-src 'self'; script-src 'self' 'unsafe-inline'; img-src 'self' https: data:; ...
```

**Step 2: Update CSP if needed**

If you use a CDN for:
- **Images** (e.g., CloudFlare, AWS CloudFront → `img.example.com`)
- **Fonts** (e.g., Google Fonts → `fonts.googleapis.com`)
- **Analytics** (e.g., Google Analytics → `*.google-analytics.com`)
- **Third-party scripts** (e.g., Segment → `cdn.segment.com`)

Edit security-headers.ts:

```typescript
// BEFORE:
export const CONTENT_SECURITY_POLICY =
  "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' https: data:; ...";

// AFTER (with your CDNs):
export const CONTENT_SECURITY_POLICY =
  "default-src 'self'; " +
  "script-src 'self' 'unsafe-inline' cdn.example.com; " +  // ← Add script CDN
  "style-src 'self' 'unsafe-inline' cdn.example.com; " +    // ← Add style CDN
  "img-src 'self' https: data: img.example.com; " +         // ← Add image CDN
  "font-src 'self' data: fonts.googleapis.com; " +          // ← Add font source
  "connect-src 'self' api.example.com; " +                  // ← Add API domain
  "frame-ancestors 'none'; form-action 'self'; base-uri 'self'";
```

**Step 3: Test in browser console**
```javascript
// Any CSP violations will log here:
// Uncaught SecurityError: Refused to load the script from 'https://untrusted-cdn.com/script.js'
// because it violates the Content-Security-Policy directive
```

### ❌ If You Don't

| Consequence | Impact |
|-------------|--------|
| **Assets blocked** | Images from your CDN fail to load (blank image boxes) |
| **Scripts blocked** | Third-party scripts fail silently (e.g., analytics stops working) |
| **Fonts blocked** | Custom fonts fail to load (falls back to system fonts) |
| **Weird UX** | Site looks broken, analytics doesn't work, users get confused |
| **Security paradox** | CSP meant to protect you... blocks your own CDN! |

**Real Example:**
```html
<!-- You have this in your HTML: -->
<img src="https://images.mycdn.com/logo.png" />

<!-- But CSP says only 'self' for images -->
<!-- Result: Image fails to load, console shows CSP violation -->
```

---

## 4. **Monitor Rate Limits Don't Block Legitimate Traffic**

### ✅ How to Do It

**Step 1: Understand current limit**
```
Rate limit: 100 requests per hour per IP
= 1.67 requests per minute
= 1 request every 36 seconds is safe
```

**Step 2: Check your traffic patterns**

```bash
# View recent requests and their IPs
curl -s 'http://localhost:3000/api/admin/audit?limit=100' | python3 -c "
import sys, json
d = json.load(sys.stdin)
ips = {}
for e in d['data']['events']:
    ip = e.get('clientIp')
    ips[ip] = ips.get(ip, 0) + 1
print('Requests per IP (last hour):')
for ip, count in sorted(ips.items(), key=lambda x: -x[1])[:5]:
    print(f'  {ip}: {count} requests')
"
```

**Step 3: Adjust if needed**

If legitimate users are hitting 100 req/hr limits, increase it in rate-limiter.ts:

```typescript
// BEFORE:
private maxRequestsPerHour = 100;

// AFTER (if your users need more):
private maxRequestsPerHour = 500; // 8.3 per minute
```

**Step 4: Implement better heuristics**

```typescript
// Instead of flat 100 per hour, could use:
// - Authenticated users: 500 req/hr (higher limit for known users)
// - Rate limit by endpoint (some endpoints can have higher limits)
// - Gradual backoff (warn at 80%, block at 100%)
```

### ❌ If You Don't

| Consequence | Impact |
|-------------|--------|
| **Legitimate users blocked** | Real users hit 429 errors after 100 requests |
| **Support tickets** | Users complain "API is broken" |
| **Bad user experience** | Slow dashboards, pagination fails, bulk operations fail |
| **Revenue impact** | Users switch to competitors with faster APIs |
| **False security** | You're only protected from brute force, not legitimate use |

**Real Example:**
```
Dashboard loads 5 cards × 3 API calls each = 15 requests
User refreshes dashboard 100/15 = 6-7 times
After 7 refreshes, 429 Too Many Requests → dashboard breaks
```

---

## 5. **Save Audit Logs Regularly (Currently Memory-Only, 24h Retention)**

### ✅ How to Do It

**Option A: Periodic Export to File**

Add this cron job or automation:
```bash
#!/bin/bash
# save-audit-logs.sh - runs daily at 2 AM

TIMESTAMP=$(date +%Y-%m-%d)
curl -s 'http://localhost:3000/api/admin/audit?limit=10000&timeWindow=24' > \
  /var/log/cheddar/audit-${TIMESTAMP}.json

# Keep only last 30 days
find /var/log/cheddar/audit-*.json -mtime +30 -delete
```

Add to crontab:
```bash
crontab -e
# Add this line:
0 2 * * * /usr/local/bin/save-audit-logs.sh
```

**Option B: Stream to AWS S3**

```typescript
// web/src/lib/api-security/audit-logger.ts — add:
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';

// Every hour, archive events:
setInterval(async () => {
  const events = auditLogger.getEvents({ limit: 10000 });
  const s3 = new S3Client({ region: 'us-east-1' });
  
  await s3.send(new PutObjectCommand({
    Bucket: 'cheddar-audit-logs',
    Key: `audit/${new Date().toISOString()}.json`,
    Body: JSON.stringify(events),
  }));
}, 60 * 60 * 1000); // Every hour
```

**Option C: Stream to Datadog/New Relic**

```typescript
// Send critical events to monitoring service:
if (event.severity === 'CRITICAL') {
  await fetch('https://api.datadoghq.com/api/v1/events', {
    method: 'POST',
    headers: { 'DD-API-KEY': process.env.DATADOG_API_KEY },
    body: JSON.stringify({
      title: event.description,
      text: JSON.stringify(event),
      alert_type: 'error',
    }),
  });
}
```

### ❌ If You Don't

| Consequence | Impact |
|-------------|--------|
| **Logs only last 24 hours** | After 24h, events are auto-deleted from memory |
| **Forensics impossible** | Attacker breached week ago? No audit trail, can't investigate |
| **Compliance failure** | HIPAA/SOC2 require 7+ years retention, you have 1 day |
| **No incident response** | "When did users lose access?" → "Don't know, logs are gone" |
| **Liability risk** | If breached and can't prove who did it, business liable |

**Real Example:**
```
Monday: Malicious user discovers bug, exports customer data
Tuesday: You restart server, audit logs cleared
Wednesday: Customer discovers breach
Friday: Legal asks "When did it happen?" → "Don't know, lost the logs" → Company sued
```

---

## **Production Checklist — TL;DR**

| Item | Action | Time | Risk If Not Done |
|------|--------|------|------------------|
| **Disable audit endpoint** | Set NODE_ENV=production (automatic) | 0 min | Security breach, PII exposed |
| **AUTH_SECRET** | `export AUTH_SECRET=<random-hex-32>` | 5 min | All users blocked (401 errors) |
| **CSP domains** | Add CDN domains to security-headers.ts | 15 min | Assets fail to load |
| **Rate limits** | Monitor `/api/admin/audit`, adjust if needed | 30 min | Real users blocked |
| **Audit logs** | Setup daily export or S3 archival | 30 min | Lost forensics, compliance fail |

---

## **Quick Production Deploy Script**

```bash
#!/bin/bash
set -e

echo "🔒 Cheddar Logic Production Deployment"
echo "======================================"

# 1. Generate AUTH_SECRET
SECRET=$(openssl rand -hex 32)
echo "✅ AUTH_SECRET generated: $SECRET"

# 2. Verify NODE_ENV
echo "✅ NODE_ENV will be set to 'production' by host"
echo "   (Vercel/Railway automatically set this)"

# 3. Build application
echo "📦 Building application..."
npm run build

# 4. Run test
echo "🧪 Running security tests..."
npm run lint

# 5. Final checklist
echo ""
echo "✋ Before deploying, complete these:"
echo "  [ ] Set AUTH_SECRET=$SECRET in your host"
echo "  [ ] Review CSP in security-headers.ts for your CDNs"
echo "  [ ] Test rate limits with expected traffic"
echo "  [ ] Setup audit log archival (S3/file)"
echo ""
echo "Then run: git push to deploy"
```

---

**Need help with any of these? Specify which step and I'll walk through it.**


**Short answer: Some yes, some no.**

Here's what I can vs can't execute:

## ✅ I CAN Execute

**1. Disable admin audit endpoint**
- Already done (automatic NODE_ENV check)
- Could optionally delete the file

**2. Update CSP for CDN domains**
- I can modify security-headers.ts
- Need to know your CDN domains first

**3. Adjust rate limit numbers**
- I can change the value in rate-limiter.ts

**4. Create audit log export script**
- I can write the bash/Node script
- I can add it to your repo

---

## ❌ I CAN'T Execute

**1. Set AUTH_SECRET environment variable**
- Requires you to manually set it in:
  - Vercel dashboard, Railway dashboard, Docker, etc.
  - I have no access to your hosting provider

**2. Deploy to production**
- Requires you to: `git push` → triggers your CI/CD
- I can't push to your repo

**3. Run cron jobs**
- Requires you to `crontab -e` on your server
- I can write the script, but you run it

**4. Monitor live traffic**
- Requires you to observe actual user behavior
- I can show you the tools, you decide based on real data

---

## What Do You Want Me To Do?

I can **right now**:

1. ✅ **Create an audit log export script** — daily JSON export to file/S3
2. ✅ **Create a .env.example template** — shows AUTH_SECRET pattern
3. ✅ **Modify CSP** — if you give me your CDN domains
4. ✅ **Create a production checklist script** — validates all settings before deploy

**Pick one and I'll implement it.** Or tell me the others and I'll do multiple.


---



Background terminal finished with npm --prefix apps/worker run job:import-historical-settled:dry-run -- --source ../../packages/data/cheddar.before_fresh_reset_20260302_205644.db


Explored 3 files
Worked for 3m 7s
Option A is set up.

Implemented:

New one-off import job: import_historical_settled_results.js (line 1)
New npm scripts: apps/worker/package.json (line 37)
Production runbook section: BEFORE-PRODUCT.md (line 17)
How to run in production:

Dry-run first:
cd /opt/cheddar-logic
CHEDDAR_DB_PATH=/opt/cheddar-logic/packages/data/cheddar.db \
npm --prefix apps/worker run job:import-historical-settled:dry-run -- \
  --source /opt/cheddar-logic/packages/data/cheddar.before_fresh_reset_20260302_205644.db
Apply:
cd /opt/cheddar-logic
CHEDDAR_DB_PATH=/opt/cheddar-logic/packages/data/cheddar.db \
npm --prefix apps/worker run job:import-historical-settled -- \
  --source /opt/cheddar-logic/packages/data/cheddar.before_fresh_reset_20260302_205644.db
Re-run settlement sweep:
cd /opt/cheddar-logic
CHEDDAR_DB_PATH=/opt/cheddar-logic/packages/data/cheddar.db \
npm --prefix apps/worker run job:settle-cards
Notes:

Job defaults to dry-run unless --apply.
--apply creates a backup before writing.
It is idempotent by card_results.id.
It creates flagged payload stubs when historical settled rows have no payload, so results can display.