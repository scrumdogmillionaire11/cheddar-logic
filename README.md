# cheddar-logic

This repository powers **cheddarlogic.com**.

## Database Ownership Contract (Canonical)

Cheddar Logic uses a single shared SQLite/sql.js database file.

- **Worker (`apps/worker`) is the only writer**: runs migrations, writes model outputs, writes card payloads, and saves DB snapshots.
- **Web (`web/`) is read-only**: serves API responses and UI from worker-produced data.
- **Production DB path is fixed**: `CHEDDAR_DB_PATH=/opt/data/cheddar-prod.db`.

Authoritative rules and rationale: [`docs/decisions/ADR-0002-single-writer-db-contract.md`](docs/decisions/ADR-0002-single-writer-db-contract.md).

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
4) **Database**: shared SQLite/sql.js persistence (single-writer contract)

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
- `export CHEDDAR_DB_PATH=/tmp/cheddar-logic/cheddar.db` (local)
- `npm --prefix packages/data run migrate`

Migrations are part of the worker-owned write path. Run them from `packages/data` or worker startup tooling only; do not add web-side migration or snapshot-save paths.

To populate with real odds data, run:
- `npm --prefix apps/worker run job:pull-odds` (fetches live games from The Odds API)

### 2) Run worker (sole DB writer)

- `npm --prefix apps/worker run scheduler`

The worker owns model execution, migrations, writes, and sql.js snapshot saves.

### 3) Run web (read-only)

- `npm --prefix web install`
- `npm --prefix web run dev`

Web reads from the shared DB but must never perform DB writes, migrations, or snapshot saves. Web teardown must use the read-only close path defined in ADR-0002.

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
  - app/UI env vars as needed (no web-side DB migrations or snapshot writes)
- Worker uses:
  - `CHEDDAR_DB_PATH` (required in production: `/opt/data/cheddar-prod.db`)
  - provider keys (`ODDS_API_KEY`, etc.)

Deprecated DB path variables must not be used for production runtime guidance. In production, set exactly `CHEDDAR_DB_PATH=/opt/data/cheddar-prod.db`.

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
- `docs/decisions/ADR-0002-single-writer-db-contract.md` — worker-only DB write ownership and web read-only contract
- `docs/WORKING_AGREEMENTS.md` — guardrails for agents + contributors
- `docs/DATA_PIPELINE_TROUBLESHOOTING.md` — inefficient-model replacement runbook (triggers/action matrix/rollback)
- `docs/ARCHITECTURE_SEPARATION.md` — phased rollout flags and production-safe rollback sequence
- `docs/API_BASELINES.md` — telemetry SQL baselines for projection and CLV ledgers

*Positioned as analytical infrastructure for research and decision-support purposes.*
