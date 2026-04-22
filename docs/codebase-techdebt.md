**1. Executive Assessment**

The codebase is moderately to heavily legacy-burdened, but not “rewrite-burdened.” The debt is concentrated in a few central surfaces: worker model runners, web card/result shaping, DB contract migration scars, feature-flag/frozen-domain drift, and JSON payload analytics. The debt is compounding because new model hardening work is being added on top of compatibility layers instead of retiring old contracts.

Top 5 legacy hotspots:
1. Worker model runners: [run_mlb_model.js](/Users/ajcolubiale/projects/cheddar-logic/apps/worker/src/jobs/run_mlb_model.js), [run_nhl_model.js](/Users/ajcolubiale/projects/cheddar-logic/apps/worker/src/jobs/run_nhl_model.js), [run_nba_model.js](/Users/ajcolubiale/projects/cheddar-logic/apps/worker/src/jobs/run_nba_model.js)
2. Web read/repair path: [route-handler.ts](/Users/ajcolubiale/projects/cheddar-logic/web/src/lib/games/route-handler.ts), [transform/index.ts](/Users/ajcolubiale/projects/cheddar-logic/web/src/lib/game-card/transform/index.ts)
3. DB architecture transition: [connection.js](/Users/ajcolubiale/projects/cheddar-logic/packages/data/src/db/connection.js), [db-dual-init.js](/Users/ajcolubiale/projects/cheddar-logic/packages/data/src/db-dual-init.js), [db-multi.js](/Users/ajcolubiale/projects/cheddar-logic/packages/data/src/db-multi.js)
4. Decision contract compatibility: [ADR-0004](/Users/ajcolubiale/projects/cheddar-logic/docs/decisions/ADR-0004-decision-pipeline-v2-hard-cut.md), [ADR-0003 legacy deprecation](/Users/ajcolubiale/projects/cheddar-logic/docs/decisions/ADR-0003-legacy-decision-format-deprecation.md), [decision-policy.js](/Users/ajcolubiale/projects/cheddar-logic/packages/models/src/decision-policy.js)
5. Frozen/incomplete domains: [ADR-0011 FPL](/Users/ajcolubiale/projects/cheddar-logic/docs/decisions/ADR-0011-fpl-integration.md), [ADR-0014 NFL](/Users/ajcolubiale/projects/cheddar-logic/docs/decisions/ADR-0014-nfl-model-stub-archival.md)

Highest-interest debt:
- Decision v2 hard cut is incomplete on read/result surfaces.
- Analytics depend on parsing historical JSON payload shapes.
- Feature flags encode product state and architecture state together.
- Worker runners are too large to change cheaply.
- Package boundaries exist in policy but are still bypassed by internal `src` imports.

Top stranded transitions:
- sql.js/single-DB/dual-DB/better-sqlite3 transition.
- Legacy decision fields to `decision_v2`.
- Projection-only to odds-backed market contracts.
- FPL standalone vs main-worker bridge.
- NFL archived stub vs callable worker implementation.

**2. Legacy Hotspot Map**

- Worker runners: 3k-5k LOC files combine ingest, enrichment, model math, gating, DB writes, scheduler lifecycle, and recovery. Current impact: every sport-model change has high review and regression cost. Change risk: extreme. Debt: historical/contract/testing. Recommendation: extract write boundary, market evaluation, and payload shaping modules behind current entrypoints.
- Web games/results shaping: [route-handler.ts](/Users/ajcolubiale/projects/cheddar-logic/web/src/lib/games/route-handler.ts) is 4k+ LOC and still merges fallback rows, legacy status inference, timeout fallback, diagnostics, SQL, and payload normalization. Risk: extreme. Debt: transitional/contract/UX-platform. Recommendation: canonical read model plus explicit historical adapter.
- DB layer: [index.js](/Users/ajcolubiale/projects/cheddar-logic/packages/data/index.js:7) still advertises dual-DB as “recommended for prod,” while [ADR-0002](/Users/ajcolubiale/projects/cheddar-logic/docs/decisions/ADR-0002-single-writer-db-contract.md) and AGENTS say single-writer DB is authoritative. Risk: high. Debt: transitional/operational/knowledge. Recommendation: freeze or delete dual-DB modules unless a live ADR supersedes ADR-0002.
- Projection accuracy schema: migrations 080-086 show rapid additive schema evolution and repair migrations; [projection-accuracy.js](/Users/ajcolubiale/projects/cheddar-logic/packages/data/src/db/projection-accuracy.js) uses many payload path probes. Risk: high. Debt: data/model. Recommendation: promote top metrics to first-class write-time fields.
- Frozen domains: FPL/NFL are frozen or archived in docs, but schedulers/jobs remain callable if env drifts. Risk: high. Debt: operational/knowledge. Recommendation: disabled entrypoints should fail closed, not rely on env defaults.

**3. Tech Debt Register**

[Decision Compatibility Layer]  
Debt Type: Transitional / Contract  
Location: [route-handler.ts](/Users/ajcolubiale/projects/cheddar-logic/web/src/lib/games/route-handler.ts), [results route](/Users/ajcolubiale/projects/cheddar-logic/web/src/app/api/results/route.ts:74), [v1 adapter](/Users/ajcolubiale/projects/cheddar-logic/web/src/lib/game-card/transform/adapters/v1-legacy-repair.ts)  
What exists: `decision_v2` is canonical, but legacy `action/status/classification`, pre-envelope `decision_v2`, and historical payload probing still drive surfaces.  
Interest: duplicated fixes and contract tests across worker, API, UI.  
Risk: split-brain verdicts return after future market additions.  
Score: principal large; interest high; blast radius cross-cutting; compounding.  
Recommendation: migrate remaining historical rows or quarantine legacy adapters behind explicit `historical=true` read path. Priority: Now.

[Worker Runner Monoliths]  
Debt Type: Historical / Testing  
Location: [run_mlb_model.js](/Users/ajcolubiale/projects/cheddar-logic/apps/worker/src/jobs/run_mlb_model.js), [run_nhl_model.js](/Users/ajcolubiale/projects/cheddar-logic/apps/worker/src/jobs/run_nhl_model.js), [run_nhl_player_shots_model.js](/Users/ajcolubiale/projects/cheddar-logic/apps/worker/src/jobs/run_nhl_player_shots_model.js)  
What exists: huge files with model orchestration, data repair, DB writes, diagnostics, Discord, and CLI lifecycle.  
Interest: slow reviews, high merge friction, hard isolation of model math.  
Risk: small model changes can alter write behavior or operational timing.  
Score: principal large; interest severe; blast radius subsystem/cross-cutting; compounding.  
Recommendation: isolate enrichment, market selection, payload factory, and DB transaction writer. Priority: Now.

[DB Architecture Drift]  
Debt Type: Transitional / Operational  
Location: [connection.js](/Users/ajcolubiale/projects/cheddar-logic/packages/data/src/db/connection.js:304), [db-dual-init.js](/Users/ajcolubiale/projects/cheddar-logic/packages/data/src/db-dual-init.js), [db-multi.js](/Users/ajcolubiale/projects/cheddar-logic/packages/data/src/db-multi.js), [package entry](/Users/ajcolubiale/projects/cheddar-logic/packages/data/index.js:7)  
What exists: single-writer is production law, but old dual/multi DB code and comments remain.  
Interest: operators and agents must remember which DB story is true.  
Risk: accidental activation or wrong docs causing production lock/data issues.  
Score: principal medium; interest high; blast radius system-wide; compounding.  
Recommendation: freeze with runtime throw or delete after ADR. Priority: Now.

[JSON Payload Analytics]  
Debt Type: Data / Contract  
Location: [projection-accuracy.js](/Users/ajcolubiale/projects/cheddar-logic/packages/data/src/db/projection-accuracy.js), [cards.js](/Users/ajcolubiale/projects/cheddar-logic/packages/data/src/db/cards.js), [results route](/Users/ajcolubiale/projects/cheddar-logic/web/src/app/api/results/route.ts)  
What exists: analytics infer projection, confidence, period, market, player identity, and results from multiple JSON paths.  
Interest: every new card shape adds fallback probes.  
Risk: silent analytics drift and wrong promotion/quarantine decisions.  
Score: principal large; interest high; blast radius cross-cutting; compounding.  
Recommendation: write canonical analytics ledger rows at publish time. Priority: Now/Next.

[Feature Flag State Sprawl]  
Debt Type: Operational / Knowledge  
Location: [feature-flags.js](/Users/ajcolubiale/projects/cheddar-logic/packages/data/src/feature-flags.js), [flags.js](/Users/ajcolubiale/projects/cheddar-logic/packages/models/src/flags.js), [scheduler main](/Users/ajcolubiale/projects/cheddar-logic/apps/worker/src/schedulers/main.js)  
What exists: some flags default on, some default off, docs disagree in places. `ENABLE_FPL_MODEL` is described as production-disabled, but generic model feature default is enabled unless env is `false`.  
Interest: rollout safety depends on env memory.  
Risk: frozen code paths can wake up.  
Score: principal medium; interest high; blast radius subsystem/system-wide; compounding.  
Recommendation: central typed registry with explicit default, owner, expiry, and frozen-domain lockout. Priority: Now.

[Package Boundary Bypass]  
Debt Type: Contract  
Location: direct imports like `@cheddar-logic/data/src/feature-flags`, `@cheddar-logic/models/src/edge-calculator`, `@cheddar-logic/odds/src/config` across worker/scripts.  
What exists: public package boundaries are bypassed for useful internals.  
Interest: internal file layout becomes API.  
Risk: package cleanup breaks runtime despite package entrypoints.  
Score: principal medium; interest medium; blast radius cross-package; compounding.  
Recommendation: export intended internals from package entrypoints and extend boundary CI beyond `packages/data/src/db/**`. Priority: Next.

[Source-String Test Debt]  
Debt Type: Testing  
Location: many `web/src/__tests__/*` tests read source and assert `.includes(...)`.  
What exists: broad contract tests that inspect implementation text instead of behavior.  
Interest: refactors create noisy test churn while runtime gaps remain.  
Risk: false confidence on web/API behavior.  
Score: principal medium; interest high; blast radius web/subsystem; stable but costly.  
Recommendation: replace highest-value static tests with seeded request-level tests. Priority: Next.

**4. Stranded Transition Register**

- Old: legacy decision fields. New: `decision_v2` canonical envelope. Bridge: web transform adapters and results fallback chain. Stalled because historical rows still exist. Cost: every read path must know old fields. Action: finish or quarantine.
- Old: single all-purpose DB. New: single-writer better-sqlite3 with read-only web. Bridge: dual/multi modules, `closeDatabaseReadOnly`, lock bypass env. Stalled because old architecture docs/code remain. Action: collapse/delete.
- Old: projection-only cards. New: odds-backed execution/CLV/accuracy ledgers. Bridge: `basis`, `execution_status`, synthetic lines, fallback line contracts. Cost: analytics has to infer intent. Action: finish per market or freeze as non-executable.
- Old: FPL integrated shared betting contract. New: FPL standalone Python app. Bridge: [run_fpl_model.js](/Users/ajcolubiale/projects/cheddar-logic/apps/worker/src/jobs/run_fpl_model.js), [fpl scheduler](/Users/ajcolubiale/projects/cheddar-logic/apps/worker/src/schedulers/fpl.js), web `/fpl`. Action: freeze visibly or remove main-worker bridge.
- Old: NFL runner. New: archived disabled stub per ADR. Bridge drift: [run_nfl_model.js](/Users/ajcolubiale/projects/cheddar-logic/apps/worker/src/jobs/run_nfl_model.js) still contains a full write path, while ADR says active entrypoint should report disabled. Action: collapse to explicit disabled stub.

**5. Change-Risk Heat Map**

1. [run_mlb_model.js](/Users/ajcolubiale/projects/cheddar-logic/apps/worker/src/jobs/run_mlb_model.js): centrality high, testability medium, coupling high. Dangerous changes: model math, write idempotency, payload fields. Containment: extract write/payload/market modules.
2. [route-handler.ts](/Users/ajcolubiale/projects/cheddar-logic/web/src/lib/games/route-handler.ts): centrality extreme, testability mixed, coupling high. Dangerous changes: filters, canonical status, fallback merge, SQL. Containment: separate query, legacy adapter, response assembler.
3. [connection.js](/Users/ajcolubiale/projects/cheddar-logic/packages/data/src/db/connection.js): centrality extreme, testability decent, coupling system-wide. Dangerous changes: locks, read-only proxy, path resolution. Containment: no feature work here without DB work item.
4. [projection-accuracy.js](/Users/ajcolubiale/projects/cheddar-logic/packages/data/src/db/projection-accuracy.js): centrality high for model integrity, testability medium, coupling high. Containment: write-time schema contract.
5. [decision-pipeline-v2.js](/Users/ajcolubiale/projects/cheddar-logic/packages/models/src/decision-pipeline-v2.js): centrality high, testability good, coupling high. Containment: keep reason-code registry and threshold config canonical.

**6. Schema / Model Drift Map**

- Decision concept: old `action/status/classification`; new `decision_v2.official_status` and `canonical_envelope_v2`. Symptoms: fallback ranking and display mapping remain. Cleanup: migrate or mark historical-only.
- Market concept: old `recommended_bet_type`, `market`, `prediction`; new `market_type`, `selection`, `canonical_market_key`, locked market context. Cleanup: one canonical market contract exported to worker/web.
- Projection result: old `card_payloads.actual_result` JSON blob; new `projection_accuracy_evals` and line evals. Cleanup: stop adding JSON probes; write normalized eval rows directly.
- DB path: old `DATABASE_URL`/auto-discovery/data dir; new `CHEDDAR_DB_PATH`. Cleanup: keep non-prod discovery only; production hard-fail is correct.
- Domain state: FPL/NFL frozen in planning but still present in routes/jobs/scripts. Cleanup: frozen-domain registry enforced in scheduler and job entrypoints.

**7. Ownership / Knowledge Debt Map**

- Implicit invariant: worker is sole writer; web must use read-only DB. Risk: any route regression can violate ADR-0002. Encode with static CI for all web imports/calls, not only source-text tests.
- Implicit invariant: `PLAY/LEAN/PASS` from worker must win over legacy UI inference. Risk: adapters can reintroduce recomputation. Encode as request-level fixture tests.
- Misleading knowledge: package entry says dual-DB “recommended for prod,” contradicting active state. Document or delete.
- Magic config: `ENABLE_*` defaults are not centrally visible. Encode flag registry.
- Ownership ambiguity: scripts and worker import package internals directly, bypassing OWNERSHIP package lanes. Export public APIs.

**8. Modernization Readiness**

Can modernize now:
- Delete/freeze dual-DB modules and stale comments.
- Collapse NFL active runner to disabled stub.
- Create a feature-flag registry and frozen-domain gate.
- Replace top source-string web tests with behavioral tests.

Clean first:
- Canonical market/decision read contracts before splitting `route-handler.ts`.
- Analytics ledger fields before retiring payload JSON probes.
- Package entrypoint exports before enforcing broader import boundaries.

Do not touch yet:
- Core DB lock/read-only behavior except under a DB work item.
- Full worker runner decomposition in one PR.
- Projection accuracy schema without migration/backfill plan.

Fake modernization bait:
- Rewriting all worker runners.
- Moving to Python sidecar for betting pipeline.
- Converting all JS to TS before contracts are stabilized.
- Adding more adapters around legacy payloads instead of retiring them.

**9. 90-Day Debt Reduction Plan**

First 30 days, stop compounding:
- Add frozen-domain runtime guards for FPL/NFL/Auth.
- Fix doc/code drift around single-writer and dual-DB.
- Require all new card payloads to write canonical decision/market fields.
- Add CI checks for web DB write prohibition and broader internal package imports.

Next 30 days, resolve stranded transitions:
- Move legacy decision fallback behind explicit historical adapter.
- Collapse NFL runner to disabled stub per ADR-0014.
- Decide: delete dual-DB modules or write superseding ADR.
- Promote top projection accuracy fields out of payload JSON.

Final 30 days, make future changes cheaper:
- Split `route-handler.ts` into query, adapter, transform, response modules.
- Extract worker runner write boundary and payload factories.
- Replace source-string tests on hot routes with seeded request tests.
- Create an owner-backed debt register for remaining compatibility shims with expiry dates.

I did this as a read-only audit. I did not claim a work item, edit files, run formatters, or execute tests.