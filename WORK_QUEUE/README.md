# WORK_QUEUE

`WORK_QUEUE/` is the single source of truth for active and upcoming work.

## Architecture Decision: Python Research as Reference-Only

**Status:** Decided (WI-0507)

Python research artifacts (`Claude-research/files/`) remain as documentation and prototyping reference but are **NOT adopted for production sidecar**. All active sport expansion (Soccer, MLB, NHL, NFL) proceeds in Node/JS runtime.

See [docs/decisions/ADR-0005-python-research-reference-only.md](../docs/decisions/ADR-0005-python-research-reference-only.md) for full rationale.

---

## Active Work Items

**Updated**: 2026-04-13

Items below are listed in execution priority order for the work items that remain in `WORK_QUEUE/`.

---

### Priority 0 — Finish in-progress/claimed items

- `WI-0897`: Replace fragile source-contract tests with behavioral endpoint/transform tests *(claimed; finish by removing remaining source.includes assertions)*
- `WI-0905`: Human-facing truthfulness audit for decision explanations *(claimed; complete cross-surface manual verification and closeout evidence)*
- `WI-0708`: API contract expansion for posture-aware outputs *(claimed; complete acceptance and test evidence)*

---

### Priority 1 — Dependency chain: data truth and freshness governance

- `WI-0899`: Database truth ownership audit for stateful tables
- `WI-0900`: Timestamp integrity and freshness semantics audit *(depends on `WI-0899`)*
- `WI-0907`: Recovery-path policy audit and failure-mode classification *(depends on `WI-0900`, `WI-0901`)*
- `WI-0906`: Calibration-to-staking continuity audit *(depends on `WI-0825`, `WI-0831`, `WI-0819`)*

Execution order for this chain: `WI-0899` → `WI-0900` → `WI-0907`, with `WI-0906` immediately after.

---

### Priority 2 — Dead-surface cleanup and platform clarity

- `WI-0894`: Remove or restore dead Soccer/NCAAM model runner surfaces
- `WI-0904`: Dead-feature liquidation classification and action plan
- `WI-0766`: Define NFL data-layer spec before enabling/removing NFL model stub
- `WI-0662`: Standalone Sage frontend internal-only conversion and runbook cleanup

---

### Priority 3 — FPL usability and posture activation (execute in this order)

- `WI-0705`: Fix Build Lab "New session" frontend/backend contract mismatch
- `WI-0706`: Persist manager profile across sessions
- `WI-0710`: Wire real OCR and live player registry into screenshot parser
- `WI-0709`: Derive nextGW ceiling/floor pts to activate posture-aware transfer scoring

---

### Priority 4 — Planned medium-priority analysis item

- `WI-0834`: Risk model recalibration notebook rerun with empirically calibrated edge *(gated by >=60 days and >=300 resolved rows)*

---

### Deferred / blocked (do not schedule until auth rollout resumes)

- `WI-0794`: Activate admin API auth wall and middleware guard *(deferred)*
- `WI-0795`: AUTH_SECRET placeholder assertion + production secret rotation *(deferred)*
- `WI-0796`: JWT revocation persistence *(deferred; depends on `WI-0794`)*

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
