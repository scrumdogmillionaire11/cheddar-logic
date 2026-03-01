# cheddar-logic

This repository powers **cheddarlogic.com**.

## Identity + Naming (do not improvise)
- GitHub repo: `cheddar-logic`
- Production domain: `cheddarlogic.com`
- Internal package / namespace: `cheddarlogic` (no hyphen)

The hyphen is used **only** in the GitHub repository name.  
Do **not** use a hyphen in:
- internal imports / package namespaces
- environment variables
- database names, schema names, table names
- service names (systemd, docker compose)

If you are unsure, see `docs/IDENTITY.md`.

---

## What ships
This monorepo runs:
1) **Web app**: UI + lightweight API (`web/`)
2) **Worker**: scheduler + ingestion + sport runners (`apps/worker`)
3) **FPL Sage**: Fantasy Premier League analysis engine (`cheddar-fpl-sage/`)
4) **Database**: shared persistence (Postgres recommended)

**Rule:** the web app does not run heavy models.  
The worker generates outputs and stores them. The web reads and renders.
FPL Sage runs as a separate FastAPI service for FPL team analysis.

---

## Repo map

apps/
web/ # cheddarlogic.com (UI + API)
worker/ # jobs + schedulers + runners

packages/
core/ # shared types, validators, utilities
data/ # db schema, migrations, db client, query helpers
adapters/ # sportsbook adapters, parsers, normalizers

db/
migrations/
seeds/

infra/
docker-compose.yml
systemd/

docs/


---

## Deploy to Production

### Self-Hosted (Raspberry Pi)

**Run the entire stack on your Pi:**

```bash
# One-time setup on Pi
/opt/cheddar-logic/deploy.sh

# Future updates
git push origin main  # Push to GitHub
ssh pi@your-ip "/opt/cheddar-logic/deploy.sh"  # Deploy to Pi
```

See **[docs/DEPLOY_RASPBERRY_PI.md](docs/DEPLOY_RASPBERRY_PI.md)** for complete Pi setup guide.

### Cloud Hosting (Vercel + Railway)

**Auto-deploy via GitHub push:**

1. Connect GitHub repo to Vercel (web) and Railway (backend)
2. `git push origin main` — auto-deploys both services

See **[docs/DEPLOY_GITHUB.md](docs/DEPLOY_GITHUB.md)** for cloud setup.

---

## Quick start (local)

### Prereqs

- Node 18+ (web)
- Python 3.11+ (worker, if Python-based)
- Docker optional (compose file is not present in all branches)

### 1) Initialize local data store (SQLite)

- `npm --prefix packages/data install`
- `npm --prefix packages/data run migrate`

To populate with real odds data, run:
- `npm --prefix apps/worker run job:pull-odds` (fetches live games from The Odds API)

### 2) Run worker

- `cd apps/worker`
- run the worker (see `apps/worker/README.md` once created)

### 3) Run web

- `cd web`
- `npm install`
- `npm run dev`

### 4) Run FPL Sage (optional)

For the FPL dashboard feature:

- `cd cheddar-fpl-sage`
- `pip install -r config/requirements.txt`
- `PYTHONPATH=src /Users/ajcolubiale/projects/cheddar-logic/.venv/bin/python scripts/data_pipeline_cli.py init-db`
- `PYTHONPATH=src /Users/ajcolubiale/projects/cheddar-logic/.venv/bin/python -m uvicorn backend.main:app --reload --port 8000`
- ensure the web app points at the API: set `NEXT_PUBLIC_FPL_API_URL=http://localhost:8000/api/v1` in `web/.env.local`

#### Restart FPL Sage API (dev)

- `cd cheddar-fpl-sage`
- ensure the venv is active and deps installed: `pip install -r config/requirements.txt`
- `PYTHONPATH=src /Users/ajcolubiale/projects/cheddar-logic/.venv/bin/python -m uvicorn backend.main:app --reload --port 8000`

See [`docs/FPL_DASHBOARD.md`](docs/FPL_DASHBOARD.md) for complete setup instructions.

---

### One-command startup scripts

**Web only:**
```bash
bash scripts/start-web-local.sh
# or
./scripts/start-all.sh
```

**Web + FPL backend:**
```bash
./scripts/start-all.sh --with-fpl
```

**Quick restart (skip DB setup):**
```bash
./scripts/start-all.sh --with-fpl --skip-db
```

Open `http://localhost:3000` for web, `http://localhost:8000/docs` for FPL API.

---

## Environment

Copy `.env.example` to `.env` and set required values.

- Web uses:
  - `PUBLIC_DOMAIN`
  - `DATABASE_URL` (or calls internal API depending on your design)
- Worker uses:
  - `DATABASE_URL`
  - provider keys (`ODDS_API_KEY`, etc.)

---

## Development principles (so we don’t create microservice hell)
- Small PRs.
- Deterministic jobs (timestamps stored; idempotent behavior).
- Shared schema in `packages/data`.
- Shared adapters in `packages/adapters`.
- Output contracts are persisted as `card_payloads` and `model_outputs`.

---

## Docs
- `docs/IDENTITY.md` — naming contract (repo/domain/namespace)
- `docs/ARCHITECTURE.md` — data flow + job model + storage model
- `docs/WORKING_AGREEMENTS.md` — guardrails for agents + contributors

---LEGACY---
# Cheddar Logic LLC

A probabilistic sports analytics decision-support platform that provides statistical insights derived from sports data and public reference markets.

## Overview

Cheddar Logic specializes in abstention-first methodology - identifying when confidence is insufficient for signal generation while delivering transparent, evidence-based analytical insights.

## Core Services

- **Sports Analytics Decision-Support** (80% focus): Probabilistic modeling and market-relative signals
- **Custom Web Development** (20% focus): Technical consulting and development services

## Getting Started

See [.planning/](.planning/) for project requirements and development roadmap.

### Landing Page Frontend (`/web`)

The `web` directory contains the Next.js 14 + TypeScript marketing site.

#### Prerequisites
- Node.js 20+
- npm 10+

#### Install & Run
```bash
cd web
npm install
npm run dev
```

#### Viewing the Site
Once the server is running, open your browser and go to:

http://localhost:3000

This is the default address for the Next.js development server.
```

#### Environment Variables
Create a `.env.local` file inside `web/` and set:

| Variable | Description |
| --- | --- |
| `NEXT_PUBLIC_DISCORD_INVITE` | Discord invite URL for CTA buttons |
| `NEXT_PUBLIC_DISCORD_MEMBER_COUNT` | Text used for community size display (e.g., `"412 analysts"`) |
| `NEXT_PUBLIC_ANALYTICS_STATUS` | `online` or `paused`; drives the analytics kill switch banner |
| `NEXT_PUBLIC_ANALYTICS_LAST_UPDATED` | ISO timestamp for the kill switch metadata |

If the status is set to `paused`, analytics visuals collapse while the educational copy stays live.

#### Deployment Notes
- Designed for Vercel/Netlify. Configure the above env vars in each environment.
- Health check endpoint TBD; add before production deployment.
- Contact form currently client-side only. Wire to a serverless function or webhook with CAPTCHA before accepting submissions.

## Community

Join our Discord research community for analytical discussions and methodology insights.

---

*Positioned as analytical infrastructure for research and decision-support purposes.*