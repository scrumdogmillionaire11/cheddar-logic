# WORK_QUEUE

`WORK_QUEUE/` is the single source of truth for active and upcoming work.

## Architecture Decision: Python Research as Reference-Only

**Status:** Decided (WI-0507)

Python research artifacts (`Claude-research/files/`) remain as documentation and prototyping reference but are **NOT adopted for production sidecar**. All active sport expansion (Soccer, MLB, NHL, NFL) proceeds in Node/JS runtime.

See [docs/decisions/ADR-0005-python-research-reference-only.md](../docs/decisions/ADR-0005-python-research-reference-only.md) for full rationale.

---

## Active Work Items

**Updated**: 2026-04-03

Items below are listed in execution priority order. FPL workstream items are lowest priority and grouped at the end.

---

### Priority 1 — Projection feedback loop (close accuracy tracking gap)

- `WI-0757`: Actual result ingestion for projection cards (nhl-pace-1p and mlb-f5)
- `WI-0758`: Actual result ingestion for player prop cards (nhl-player-shots, nhl-player-blk, mlb-pitcher-k)
- `WI-0751`: NHL Player Blocks — wire actual value resolution for projection accuracy tracking

---

### Priority 2 — Active sport pipeline extensions

- `WI-0663`: MLB pitcher-K strong under monitoring
- `WI-0664`: DB migration — add public betting splits columns to odds_snapshots
- `WI-0665`: ActionNetwork adapter — fetch and normalize public betting splits
- `WI-0666`: Worker job — pull_public_splits + scheduler registration + DB write layer *(depends on WI-0664, WI-0665)*
- `WI-0667`: Pipeline gate — computePublicSplitsGate + wire PASS_SHARP_MONEY_OPPOSITE *(depends on WI-0666)*

Execution order for splits chain: `WI-0664` → `WI-0665` → `WI-0666` → `WI-0667`.

---

### Priority 3 — CI / platform hardening

- `WI-0741`: Harden audit artifact upload checks

---

### Priority 4 — FPL workstream (lowest priority, FPL last)

Quick fixes first:

- `WI-0705`: Fix Build Lab "New session" — frontend/backend contract mismatch
- `WI-0706`: Persist manager profile across sessions — onboarding state lost on reload

Data / API foundations:

- `WI-0710`: Wire real OCR and live player registry into screenshot parser
- `WI-0708`: API Contract Expansion for Posture-Aware Outputs
- `WI-0709`: Derive nextGW ceiling/floor pts from FPL data to activate posture-aware transfer scoring

Draft Lab features:

- `WI-0668`: Natural Language Intent Translation Layer
- `WI-0669`: Final Recommendation Terminal Output
- `WI-0670`: Comparison as Core Behavior and Inline Tradeoff Surface
- `WI-0672`: Draft Lab State Visibility and Reset to Baseline
- `WI-0671`: Post-Draft Season Loop Foundation

Housekeeping:

- `WI-0662`: Standalone Sage frontend internal-only conversion and runbook cleanup

---

### Archived queued items (pre-existing, not yet started)

- `WI-0485`: Phase 4 telemetry calibration report + enforcement gate
- `WI-0486`: Phase 4 soak-window runbook + weekly go/no-go cadence (depends on `WI-0485`)
- `WI-0487`: MLB expansion tranche A (odds-backed markets; depends on `WI-0485`)
- `WI-0488`: MLB expansion tranche B (projection props + rollup separation audit; depends on `WI-0485`, `WI-0487`)
- `WI-0489`: NFL expansion pack (deferred after MLB; depends on `WI-0485`, `WI-0488`)
- `WI-0500`: NHL 1P model hard alignment to WI-0385 target
- `WI-0501`: NHL SOG matchup factor wiring
- `WI-0502`: NHL calibration ledger wiring
- `WI-0503`: NHL cross-market orchestration dual-run
- `WI-0504`: NHL orchestration cutover
- `WI-0505`: NHL 1P Phase-2 gated fair-probability activation
- `WI-0506`: NHL results segmentation on `/results`
- `WI-0509`: NHL free-data settlement hardening
- `WI-0520`: AH decision gate + architecture contract
- `WI-0521`: Deterministic AH grading engine
- `WI-0522`: AH pricing model (completed ahead of schedule — see governance note in COMPLETE/)
- `WI-0523`: AH pipeline integration
- `WI-0588`: Quarantine NBA totals by demoting actionable tiers one level
- `WI-0589`: Confidence tier correction layer for PLAY vs LEAN
- `WI-0590`: Diagnose NBA totals underperformance before permanent retuning
- `WI-0591`: Wire empirical sigma overrides into NBA and NCAAM decisioning
- `WI-0592`: NHL shots props breakout-usage overlay

### MLB Pitcher Ks rollout (complete ✓ — 2026-03-26)

- ~~`WI-0595`~~: ✓ Pitcher Ks core engine (projection-only parity)
- ~~`WI-0596`~~: ✓ Pitcher Ks data foundations and freshness gates
- ~~`WI-0597`~~: ✓ Pitcher Ks odds pull + dual-mode runtime wiring
- ~~`WI-0598`~~: ✓ Pitcher Ks contract hardening (validator + market contract)
- ~~`WI-0599`~~: ✓ Pitcher Ks web integration — props surfaces (route.ts, filters, presets, dedup)
- ~~`WI-0600`~~: ✓ Pitcher Ks rollout docs + acceptance pack

**Rollout state:** Projection-only only. Event-level pitcher-K odds fetching was removed in `WI-0727`; see [docs/runbooks/pitcher-ks-rollout.md](../docs/runbooks/pitcher-ks-rollout.md) for the current operating contract.

## Recently Completed

- `WI-0484`: DRIVER_ROLES registry completeness guard
- `WI-0507`: Python research reference-only architecture decision
- `WI-0516`: Wire deterministic chip engine through FPL Sage backend + frontend
- `WI-0517`: Migrate GitHub Actions from Node 20 to Node 24-compatible actions
- `WI-0520`: AH decision gate + architecture contract
- `WI-0521`: Deterministic AH grading engine
- `WI-0522`: AH pricing model (completed ahead of schedule — see governance note in COMPLETE/)
- `WI-0527`: Projection anomaly audit layer
- `WI-0528`: Fix PP TOI gap (replace hardcoded toi_proj_pp:0)
- `WI-0529`: Decision layer for props (computePropDisplayState)
- `WI-0530`: NST PP rate ingestion (player_pp_rates table)
- `WI-0531`: Rolling PP splits (L10/L5) + recency-weighted blend
- `WI-0532`: Repo lint and TS error cleanup
- `WI-0535`: (dependency of WI-0536/0537 — see governance notes)
- `WI-0536`: Canonical edge contract + unit normalization
- `WI-0537`: FIRST_PERIOD policy centralization in canonical decision layer
- `WI-0572`: Hostile audit — betting decision pipeline (10 findings, all addressed)
- `WI-0587`: Remove ncaam-matchup-style as actionable betting source

## Rules

- One file per work item: `WI-####.md`
- Work is exclusive while claimed
- Agents only edit files listed in `Scope`
- Scope expansion must be written into the work item before code changes

## Lifecycle

1. `Unclaimed` (owner unset or `unassigned`)
2. `Claimed` (`Owner agent` set + `CLAIM:` line with timestamp)
3. `In progress` (edits happening only inside scope)
4. `Ready for review` (acceptance and testing evidence added)
5. `Closed` (merged or explicitly cancelled)

## Naming

- Branch: `agent/<agent-name>/WI-####-short-slug`
- Commit: `WI-####: <imperative summary>`

## Required Work Item Fields

- `ID`
- `Goal`
- `Scope`
- `Out of scope`
- `Acceptance`
- `Owner agent`
- `Time window`
- `Coordination flag`
- `Tests to run`
- `Manual validation`

Use `WORK_QUEUE/WI-TEMPLATE.md` for new items.
