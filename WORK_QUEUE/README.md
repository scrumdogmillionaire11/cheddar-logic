# WORK_QUEUE

`WORK_QUEUE/` is the single source of truth for active and upcoming work.

## Architecture Decision: Python Research as Reference-Only

**Status:** Decided (WI-0507)

Python research artifacts (`Claude-research/files/`) remain as documentation and prototyping reference but are **NOT adopted for production sidecar**. All active sport expansion (Soccer, MLB, NHL, NFL) proceeds in Node/JS runtime.

See [docs/decisions/ADR-0005-python-research-reference-only.md](../docs/decisions/ADR-0005-python-research-reference-only.md) for full rationale.

---

## Active Work Items

**Updated**: 2026-03-23

- `WI-0485`: Phase 4 telemetry calibration report + enforcement gate
- `WI-0486`: Phase 4 soak-window runbook + weekly go/no-go cadence (depends on `WI-0485`)
- `WI-0487`: MLB expansion tranche A (odds-backed markets; depends on `WI-0485`)
- `WI-0488`: MLB expansion tranche B (projection props + rollup separation audit; depends on `WI-0485`, `WI-0487`)
- `WI-0489`: NFL expansion pack (deferred after MLB; depends on `WI-0485`, `WI-0488`)

### NHL alignment pack (queued)

- `WI-0500`: NHL 1P model hard alignment to WI-0385 target (formula, dead-zone, goalie certainty, reason codes)
- `WI-0501`: NHL SOG matchup factor wiring (opponentFactor + paceFactor) + synthetic fallback observability
- `WI-0502`: NHL calibration ledger wiring (CLV + projection) + settlement jobs
- `WI-0506`: NHL results segmentation on `/results` (game vs 1P vs player shots props)
- `WI-0503`: NHL cross-market orchestration dual-run (market-stratified engines + expression choice log)
- `WI-0504`: NHL orchestration cutover (single best market expression per game, legacy blend retired)
- `WI-0505`: NHL 1P Phase-2 gated fair-probability activation (only with stable real 1P lines)
- `WI-0509`: NHL free-data settlement hardening (NHL API first, ESPN fallback) for 1P + player shots

Recommended execution order: `WI-0485` -> (`WI-0486` + `WI-0487` in parallel if staffing allows) -> `WI-0488` -> `WI-0489`.

NHL alignment execution order: `WI-0500` -> `WI-0501` -> `WI-0502` -> `WI-0506` -> `WI-0503` -> `WI-0504` -> `WI-0505`.

### Production performance remediation (queued)

- ~~`WI-0587`~~: Remove `ncaam-matchup-style` as an actionable betting source (DONE — qt-78)
- `WI-0588`: Quarantine NBA totals by demoting actionable tiers one level
- `WI-0589`: Confidence tier correction layer for PLAY vs LEAN
- `WI-0590`: Diagnose NBA totals underperformance before permanent retuning
- `WI-0591`: Wire empirical sigma overrides into NBA and NCAAM decisioning
- `WI-0592`: NHL shots props breakout-usage overlay

Recommended execution order: (`WI-0587` + `WI-0588`) -> `WI-0589`, with (`WI-0590` + `WI-0591`) in parallel as diagnostic/calibration enablers for later retuning.

### Soccer Asian Handicap workstream (queued)

- `WI-0520`: AH decision gate + architecture contract (Option A keep out vs Option B reintroduce)
- `WI-0521`: Deterministic AH grading engine (whole/half/quarter/zero + split outcomes)
- `WI-0522`: AH pricing model (de-vig + Poisson margin probabilities + EV)
- `WI-0523`: AH pipeline integration (canonical markets + validators + runbook)

Recommended execution order: `WI-0520` -> `WI-0521` -> `WI-0522` -> `WI-0523`.

Proposed execution branches (when each WI starts):

- `agent/github-copilot/WI-0520-ah-decision-contract`
- `agent/github-copilot/WI-0521-ah-grading-engine`
- `agent/github-copilot/WI-0522-ah-pricing-model`
- `agent/github-copilot/WI-0523-ah-tier1-integration`

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
