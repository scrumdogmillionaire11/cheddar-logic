# 2️⃣ `docs/ARCHITECTURE.md`

# Architecture Overview

```md


## Goal

Serve cheddarlogic.com with two distinct product lines:

1. **Sports Betting Dashboard** — Analytical cards for NBA/NHL/MLB/Soccer betting
2. **FPL-SAGE Dashboard** — Fantasy Premier League tools (squad planning, transfers, chips)

Both use shared infrastructure (Web + Worker + Database) but have different data models, scheduling patterns, and UX contracts.


## Products (User-Facing)

### A) Sports Betting Dashboard

**Routes:**

**Renders:**

**Data Sources:**

### B) FPL-SAGE Dashboard

**Routes:**

**Renders:**

**Data Sources:**

**Critical Distinction:**
FPL-SAGE is NOT soccer betting. It's fantasy sports with different cadence (deadline-driven vs game-time) and different data contracts.


## Runtime Components

### 1. Web — `apps/web`

**Responsibilities:**

**Does NOT:**


### 2. Worker — `apps/worker`

Single worker process with two operational domains:

#### Domain 1 — Betting Engine (Multi-Sport)

**Sports:**

**Inputs (Shared Ingestion):**

**Outputs:**

**Scheduling:**
  - Examples: `nhl|fixed|2026-02-27|0900`, `nhl|tminus|nhl-2026-02-27-van-sea|120`

**Job Names:**

#### Domain 2 — FPL-SAGE Engine

**Inputs (NOT Odds-Driven):**

**Outputs:**

**Scheduling:**

**Job Names:**


### 3. Database — Shared Data Layer

**Shared Tables (Cross-Domain):**

**Betting Domain Tables:**

**FPL-SAGE Domain Tables (Separate Namespace):**

**Key Boundary:**
FPL data must NOT pollute betting tables. Each domain maintains its own source tables. They can share `card_payloads` for rendering, but ingestion stays separate.


## Data Flow

### Betting Domain

External APIs (odds, injuries, lineups)
    ↓
Adapters (packages/adapters/odds/*)
    ↓
Canonical Snapshots (odds_snapshots, games, injuries)
    ↓
Sport Runners (apps/worker/src/jobs/betting/*)
    ↓
model_outputs + card_payloads
    ↓
Web renders betting dashboard


## Results Ledger + Grading

The Results page is a public accountability surface. It is a deterministic ledger built from the `plays` table and never recomputed from current models.

**Core rules:**

**Grading flow:**
1. Game completes
1. Pull final score
1. Grade against stored line
1. Update `result` and `profit_units`

**Versioning:**

### FPL-SAGE Domain

FPL Official API
    ↓
Adapters (packages/adapters/fpl_api/*)
    ↓
FPL Snapshots (fpl_player_snapshots, fpl_deadlines)
    ↓
FPL Runners (apps/worker/src/jobs/fpl/*)
    ↓
fpl_recommendations + card_payloads (card_type=fpl-sage-*)
    ↓
Web renders FPL dashboard


## Scheduling Model

### Betting Engine Scheduling

**Ingestion:**

**Inference:**
  - `job_key=nhl|fixed|YYYY-MM-DD|0900`
  - `job_key=nhl|tminus|<game_id>|120`

**Implementation:**

### FPL-SAGE Scheduling (Distinct Pattern)

**Ingestion:**
  - `job_key=fpl|daily|YYYY-MM-DD`

**Recommendation Engine:**
  - `job_key=fpl|deadline|GW27|T-24h`

**Implementation:**


## Reliability Rules

1. **Every job writes to `job_runs`** (idempotency + audit)
2. **All runner outputs are persisted** (model_outputs, card_payloads, fpl_recommendations)
3. **Web renders last known good payload** (never recomputes)
4. **Staleness is visible in UI** (last updated timestamps, expiry indicators)
5. **No runtime recomputation in web layer** (all logic pre-executed by worker)
6. **Idempotency everywhere** (deterministic `job_key` prevents double-firing across restarts)


## Service Boundary Rules

**Adapters (`packages/adapters`):**

**Data Package (`packages/data`):**

**Core Package (`packages/core`):**

**Worker (`apps/worker`):**

**Web (`apps/web`):**

**No additional services without documented justification.**


## Code Layout (Target Structure)

apps/
  worker/
    src/
      jobs/
        betting/
          run_nba_model.js
          run_nhl_model.js
          run_mlb_model.js
          run_soccer_epl_model.js (future)
        fpl/
          run_fpl_transfers_engine.js
          run_fpl_squad_optimizer.js
        ingestion/
          pull_odds_hourly.js
          pull_fpl_data_daily.js
      schedulers/
        main.js (single tick loop)
        windows/
          betting-windows.js (T-minus + fixed logic)
          fpl-windows.js (deadline-relative logic)
      models/
        betting/ (NHL/NBA/MLB/Soccer inference)
        fpl/ (FPL-SAGE recommendation logic)
  web/
    src/
      app/
        betting/ (betting dashboard routes)
        fpl/ (FPL-SAGE dashboard routes)
        api/
          cards/ (shared card endpoint)
          betting/ (betting-specific if needed)
          fpl/ (FPL-specific if needed)

packages/
  data/ (shared DB + migrations)
  adapters/
    odds/
    soccer_lineups/
    injuries/
    fpl_api/
  core/ (shared utils)
  models/ (future: extracted model logic)


## Non-Negotiable Boundaries

1. **FPL-SAGE is its own domain:** No odds, no T-minus game windows. Deadline-driven with weekly/bi-weekly cadence.
2. **Soccer betting models belong to betting domain:** Same contract as NHL/NBA/MLB (odds + T-minus windows).
3. **Web only renders:** It can filter/search/sort, but it doesn't compute predictions or recommendations.
4. **Everything persists:** Worker writes outputs to DB; web reads stored payloads.
5. **Idempotency everywhere:** Deterministic `job_key` prevents double-firing across restarts and failures.
6. **No new services:** Single worker, single web app, shared database. Scaling happens via horizontal worker replication (future) or Postgres migration (if needed).


## Timezone Rules

  - Fixed windows computed in ET (09:00 ET = 14:00 UTC in winter, 13:00 UTC in summer)
  - UI displays can be user-localized, but scheduler runs in ET


## Migration Path (Current → Target)

**Current State:**

**Target State:**

**Next Steps:**
1. Upgrade scheduler to window-based (betting domain first)
2. Refactor FPL from betting-style to deadline-style
3. Add soccer betting models (EPL/MLS/UCL)
4. Extract FPL tables from betting namespace
```