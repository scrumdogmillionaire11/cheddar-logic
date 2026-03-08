# Deploy cheddarlogic.com via GitHub

## TL;DR

After one-time platform setup, deploy with:

```bash
git push origin main
```

Both web and backend auto-deploy from your GitHub repo.

---

## One-Time Setup

### 1. Connect Vercel (Web Frontend)

1. **Sign in**: [vercel.com/login](https://vercel.com/login) with GitHub
2. **Import project**: New → Import Git Repository → Select `cheddar-logic`
3. **Configure**:
   - Framework: Next.js
   - Root directory: `web`
   - Build: `npm run build`
   - Install: `npm install`
4. **Environment variables** (in Vercel dashboard):

   ```env
   FPL_API_BASE_URL=https://api.cheddarlogic.com/api/v1
   NEXT_PUBLIC_PUBLIC_DOMAIN=https://cheddarlogic.com
   NEXT_PUBLIC_API_BASE_URL=https://cheddarlogic.com
   AUTH_SECRET=your-secret-here
   # Persistent DB path (must match worker)
   CHEDDAR_DB_PATH=/opt/data/cheddar-prod.db
   # Feature flags (explicitly set in production)
   NEXT_PUBLIC_ENABLE_PLAYER_PROPS=false
   NEXT_PUBLIC_CARDS_TRACE_VERBOSE=false
   ODDS_API_KEY=...
   ```
5. **Custom domain**: Settings → Domains → Add `cheddarlogic.com`

### 2. Connect Railway (FPL Backend)

1. **Sign in**: [railway.app](https://railway.app) with GitHub
2. **Deploy from GitHub**: New → Deploy from GitHub repo → Select `cheddar-logic`
3. **Railway auto-detects** `railway.json` config in repo root
4. **Add Redis**: New → Redis → Copy URL to env vars
5. **Environment variables**:

   ```env
   FPL_SAGE_REDIS_URL=redis://default:password@host:port
   FPL_SAGE_UNLIMITED_ACCESS_ENABLED=true
   FPL_SAGE_UNLIMITED_TEAMS=711511,1930561
   FPL_SAGE_RATE_LIMIT_ENABLED=true
   FPL_SAGE_CACHE_ENABLED=true
   ```
6. **Custom domain**: Settings → Generate Domain → Add `api.cheddarlogic.com`

### 3. DNS (Cloudflare)

| Record | Type   | Target                            |
|--------|--------|-----------------------------------|
| `@`    | CNAME  | `cname.vercel-dns.com` (from Vercel) |
| `www`  | CNAME  | `@`                               |
| `api`  | CNAME  | `xyz.up.railway.app` (from Railway) |

---

## Deploy Workflow

After setup, every commit to `main` triggers deployment:

```bash
# Make changes
git add .
git commit -m "feat: new feature"

# Push triggers auto-deploy
git push origin main
```

**Watch deployments**:
- Web: [vercel.com/dashboard](https://vercel.com/dashboard)
- Backend: [railway.app/dashboard](https://railway.app/dashboard)

---

## Rollback

Both platforms support instant rollback:

**Vercel**:
1. Go to Deployments
2. Select previous successful deployment
3. Click "Promote to Production"

**Railway**:
1. Go to Deployments tab
2. Select previous deployment
3. Click "Redeploy"

---

## Test Before Push

Run locally to catch issues early:

```bash
# Lint and build web
npm --prefix web run lint
npm --prefix web run build

# Start backend and test health
cd cheddar-fpl-sage
PYTHONPATH=.:$PWD/src uvicorn backend.main:app --port 8000 &
curl http://localhost:8000/api/v1/health
```

---

## Verify Production

After deployment:

```bash
curl -I https://cheddarlogic.com
curl -i https://api.cheddarlogic.com/api/v1/health
curl -i https://cheddarlogic.com/api/v1/health  # Proxied through Next.js
```

Then open in browser:

- [cheddarlogic.com](https://cheddarlogic.com)
- [cheddarlogic.com/cards](https://cheddarlogic.com/cards)
- [cheddarlogic.com/fpl](https://cheddarlogic.com/fpl)

---

## Pre-Deploy Checklist

Before promoting to production:

- [ ] `CHEDDAR_DB_PATH` is set identically in web and worker env vars (persistent path, not /tmp)
- [ ] `run_state` table exists and has a non-null `current_run_id` (worker must have run at least once)
- [ ] `/api/games` returns non-empty plays array in staging before promoting to prod

**Deploy gates** (automatic):

- Deploy workflow verifies CSS/JS assets load and logs API warnings to `/opt/cheddar-logic/logs/deploy.log`.
- API checks are warning-only (observability-first) and do not block deploys.
- Each deploy writes one compact `[deploy-summary]` line with warning count and endpoint status snapshot.

## No-Plays Prevention Checklist

Use this after deploys to avoid PASS-only boards:

1. **DB path consistency**
   - Web and worker must resolve the same `CHEDDAR_DB_PATH` (persistent file).
2. **Run state present**
   - `run_state.current_run_id` exists and matches recent `card_payloads.run_id`.
3. **Fresh odds**
   - `odds_snapshots` has a recent `captured_at` for each active sport.
4. **Model jobs enabled**
   - `ENABLE_NHL_MODEL`, `ENABLE_NBA_MODEL`, `ENABLE_NCAAM_MODEL` are `true` in production.

Sample checks on the server:

```bash
set -a; source /opt/cheddar-logic/.env.production; set +a
sqlite3 "$CHEDDAR_DB_PATH" "SELECT id, current_run_id FROM run_state;"
sqlite3 "$CHEDDAR_DB_PATH" "SELECT sport, MAX(captured_at) FROM odds_snapshots GROUP BY sport;"
sqlite3 "$CHEDDAR_DB_PATH" "SELECT run_id, COUNT(*) FROM card_payloads GROUP BY run_id ORDER BY COUNT(*) DESC LIMIT 5;"
```

---

## Files That Enable GitHub Deploy

- `.github/workflows/deploy-production.yml` — CI/CD validation (optional, platforms handle deploy)
- `vercel.json` — Vercel project config
- `railway.json` — Railway service config
- `web/next.config.ts` — Production API routing
- `docs/DEPLOYMENT.md` — Full runbook

---

## Troubleshooting

### Build fails on Vercel

- Check build logs in Vercel dashboard
- Verify all env vars are set
- Run `npm --prefix web run build` locally first

### Backend not responding

- Check Railway logs for startup errors
- Verify Redis is connected
- Check `FPL_SAGE_REDIS_URL` env var

### DNS not resolving

- Wait 5-60 minutes for propagation
- Verify CNAME targets match platform dashboards
- Check Cloudflare proxy status (orange vs gray cloud)

### API calls fail from web

- Check `FPL_API_BASE_URL` in Vercel env vars
- Verify backend health: `curl https://api.cheddarlogic.com/api/v1/health`
- Check Next.js rewrite in `web/next.config.ts`
