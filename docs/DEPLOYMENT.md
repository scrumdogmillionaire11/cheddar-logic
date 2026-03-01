# Deployment Runbook (cheddarlogic.com)

## Recommended: GitHub Auto-Deploy

**Easiest path**: Connect your GitHub repo to hosting platforms and deploy via `git push`.

### 1) Initial Setup (One-Time)

#### Connect Web → Vercel

1. Visit [vercel.com/new](https://vercel.com/new)
2. Import `cheddar-logic` repo
3. Configure project:
   - **Framework Preset**: Next.js
   - **Root Directory**: `web`
   - **Build Command**: `npm run build`
   - **Install Command**: `npm install`
   - **Output Directory**: Leave default (`.next`)

4. Set environment variables in Vercel dashboard:
   ```
   FPL_API_BASE_URL=https://api.cheddarlogic.com/api/v1
   NEXT_PUBLIC_PUBLIC_DOMAIN=https://cheddarlogic.com
   NEXT_PUBLIC_API_BASE_URL=https://cheddarlogic.com
   AUTH_SECRET=<generate-strong-random-secret>
   ```

5. Add custom domain: `cheddarlogic.com`

#### Connect Backend → Railway

1. Visit [railway.app/new](https://railway.app/new)
2. Deploy from GitHub repo
3. Railway auto-detects `railway.json` config
4. Add environment variables from `cheddar-fpl-sage/backend/.env.example`:
   ```
   FPL_SAGE_REDIS_URL=<railway-redis-url>
   FPL_SAGE_UNLIMITED_ACCESS_ENABLED=true
   FPL_SAGE_UNLIMITED_TEAMS=<team-ids>
   FPL_SAGE_RATE_LIMIT_ENABLED=true
   FPL_SAGE_RATE_LIMIT_REQUESTS_PER_HOUR=100
   FPL_SAGE_CACHE_ENABLED=true
   FPL_SAGE_CACHE_TTL_SECONDS=300
   ```

5. Add Redis service in Railway project
6. Attach custom domain: `api.cheddarlogic.com`

#### DNS (Cloudflare)

| Record | Type | Target |
|--------|------|--------|
| `@` | A/CNAME | Vercel target (from dashboard) |
| `www` | CNAME | `@` or Vercel target |
| `api` | CNAME | Railway backend URL |

### 2) Deploy via Git Push

After setup, every push to `main` auto-deploys:

```bash
git add .
git commit -m "feat: new feature"
git push origin main
```

- **Vercel**: Deploys web automatically (watch at vercel.com/dashboard)
- **Railway**: Deploys backend automatically (watch at railway.app)

### 3) Rollback

Both platforms support instant rollback via dashboard:

- **Vercel**: Deployments tab → Previous deployment → Promote to Production
- **Railway**: Deployments tab → Previous deployment → Redeploy

## Alternative: Manual Deploy

If you prefer manual control over GitHub auto-deploy:

### Web (Vercel CLI)

```bash
cd web
npm install -g vercel
vercel --prod
```

### Backend (Railway CLI)

```bash
npm install -g @railway/cli
railway login
railway link
railway up
```

## Pre-Deployment Checklist

Run locally before pushing:

```bash
# Web build check
npm --prefix web run lint
npm --prefix web run build

# Backend health check
cd cheddar-fpl-sage
python -m pip install -r config/requirements.txt
PYTHONPATH=.:$PWD/src python -m uvicorn backend.main:app --host 0.0.0.0 --port 8000 &
sleep 5
curl -i http://localhost:8000/api/v1/health
```

## Worker (Linux Server)

Deploy the scheduler to a VPS using systemd:

```bash
# On server
sudo cp cheddar-worker.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable cheddar-worker
sudo systemctl restart cheddar-worker
sudo systemctl status cheddar-worker

# View logs
journalctl -u cheddar-worker -f
```

## Post-Deploy Verification

After push deploys or manual deploys:

```bash
curl -I https://cheddarlogic.com
curl -i https://api.cheddarlogic.com/api/v1/health
curl -i https://cheddarlogic.com/api/v1/health  # Should proxy to backend
```

Then verify in browser:
- https://cheddarlogic.com
- https://cheddarlogic.com/cards
- https://cheddarlogic.com/fpl

