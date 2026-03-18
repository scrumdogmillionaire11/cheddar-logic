# WORK_QUEUE

`WORK_QUEUE/` is the single source of truth for active and upcoming work.

## Active Work Items

**Updated**: 2026-03-17

### Recently Completed

- `WI-0480`: Phase 2 Activation + Rollback Procedure (Thresholds V2)
- `WI-0481`: Phase 3 Preflight Eligibility + SQL Verification (CLV)
- `WI-0482`: Phase 3 Activation + Settlement-Safe Rollback (CLV)
- `WI-0483`: Fix nba-blowout-risk role and document unclassified NHL cardTypes in DRIVER_ROLES
- `WI-0484`: DRIVER_ROLES registry completeness guard

- `WI-0379`: Canonical Goalie State Object
- `WI-0380`: Goalie Source Arbitration Layer
- `WI-0381`: Pace Model Trust Gating
- `WI-0382`: Consistency Check Goalie Uncertainty Escalation
- `WI-0383`: Watchdog/Wrapper Semantic Alignment
- `WI-0384`: NHL Totals Fault Harness
- `WI-0385`: NHL 1P Model Rebuild (Pass-First, De-biased)
- `WI-0389`: MLB Pitcher Ks Research Spec Freeze
- `WI-0398`: Consolidate Game-Card Decision Helper Sources
- `WI-0399`: Migrate Legacy play.status Branching to Canonical Decision Accessors
- `WI-0401`: Investigate NCAAM FT-Trend Market-Type Drift (Spread -> Moneyline)
- `WI-0403`: Automated PENDING_VERIFICATION Resolution via Retrospective Edge Validation
- `WI-0405`: Retire Legacy NCAAM FT Card Alias
- `WI-0406`: Centralize FT Trend Context Contract
- `WI-0407`: Replace Brittle FT Source Test with Behavior Coverage
- `WI-0408`: Unify Decision Status Enum Across Web Contracts
- `WI-0409`: Remove FT Note Regex Fallback After Structured Context Hardening
- `WI-0413`: NHL Totals + Goalie Confirmation Semantics Audit (Scoping)
- `WI-0414`: NCAAM FT-Trend Decision Semantics (PLAY/LEAN vs PASS)
- `WI-0415`: Standardize Web WI Test Command Template
- `WI-0417`: Starting XI Logic Requirements for FPL Sage (draft)
- `WI-0434`: Audit Sports Models Against Canonical Logic (Current Repo Layout, No Rebuild)
- `WI-0435`: Projection Contract Alignment (Current API Surfaces, No Rebuild)
- `WI-0436`: NHL Data Enrichment (Targeted, No Rebuild)
- `WI-0437`: Soccer Data Hardening (Environment Projector Incremental, No Rebuild)
- `WI-0471`: Non-Breaking Rollout Foundation (Flags + Basis Contract + Projection Telemetry)
- `WI-0472`: Phase 1 Low-Volatility Integration (NHL Shots + Soccer Projection Basis)
- `WI-0473`: Phase 2 Sport+Market Thresholds V2 (Efficiency-Aware Decisioning)
- `WI-0474`: Phase 3 CLV Ledger Integration for Odds-Backed Markets
- `WI-0475`: Inefficient Model Replacement Policy + Ops Runbook
- `WI-0476`: Soccer Team Mapping Alias Coverage for Odds Intake
- `WI-0477`: Phase 2 Rollout Coordinator (Market Thresholds V2)
- `WI-0478`: Phase 3 Rollout Coordinator (CLV Ledger)
- `WI-0479`: Phase 2 Preflight + Baseline Evidence (Thresholds V2)

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
