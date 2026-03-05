# Project State

**Phase:** 1 of 4 - ✅ COMPLETE  
**Status:** Ready for Phase 2  
**Last Activity:** 2026-03-04 - Phase 1 consolidation complete

## Full Roadmap

| Phase | Name | Status | Objective |
| --- | --- | --- | --- |
| 1 | Model Logic Consolidation | ✅ COMPLETE | Extract shared utilities, centralize edge ownership, consolidate card factory |
| 2 | FPL Dual-Engine Resolution | ⏳ PENDING DECISION | Decide on Sage vs Worker + define contract, or keep separate with interfaces |
| 3 | Documentation & Handoff | ⏳ NOT STARTED | Create runbooks, define consolidation ownership contracts, final enforcement audit |
| 4 | Future Extension Framework | ⏳ NOT STARTED | Design plugin system for new sports, establish extension patterns |

## Phase 1 Details ✅

**Completed Tasks:**
- 1.1 Extract shared card utilities (computeWinProbHome, buildDriverSummary)
- 1.2 Centralize edge ownership in cross-market.js with provenance metadata
- 1.3 Consolidate card generation to unified factory (generateCard)

**Metrics:**
- 584 LOC removed
- 0 behavior change
- 4 atomic commits
- 3-layer enforcement stack (AST + fixtures + provenance)

## Phase 2 Details ⏳

**Objective:** Resolve FPL (Fantasy Premier League) dual-engine situation

**Options:**
1. Replace worker with Sage (consolidate all to single inference engine)
2. Keep separate but define contract (clear API boundary between engines)
3. Merge into unified JS (consolidate all logic to single language)

**Blocker:** Requires product decision on vision for FPL vs sports model integration

**Status:** Awaiting user direction

## Phase 3 Details ⏳

**Objective:** Formalize consolidation boundaries and document ownership

**Tasks:**
- Create runbooks for extending to new sports
- Document consolidation ownership contracts
- Lock enforcement via pre-commit hooks
- Final audit of all consolidated modules

## Phase 4 Details ⏳
**Objective:** Design framework for future model additions

**Tasks:**
- Define plugin architecture for new sports (e.g., NFL, MLS, Cricket)
- Establish patterns for shared vs sport-specific logic
- Create template for new sport implementation

## Decisions Made

| Decision | Context | Status |
| --- | --- | --- |
| Edge calculation single-sourced in cross-market.js | Prevent silent drift, single source of truth | ✅ Approved |
| NCAAM sigma=11 preserved as intentional variance | College spreads have different statistical properties | ✅ Locked |
| Card factory parameterized by sport | Simpler than inheritance, easier to extend | ✅ Approved |
| Defer FPL decision to Phase 2 | Requires product vision input | ⏳ Pending |

## Completion Criteria

- [ ] Phase 1: Model logic consolidated (✅ DONE)
- [ ] Phase 2: FPL strategy defined and implemented
- [ ] Phase 3: Ownership contracts formalized
- [ ] Phase 4: Extension framework documented

## Session Continuity

**Last Session:** 2026-03-04  
**Stopped At:** Phase 1 complete  
**Resume File:** None (ready for Phase 2 or wrap)  
**Next Action:** Await input on Phase 2 FPL decision