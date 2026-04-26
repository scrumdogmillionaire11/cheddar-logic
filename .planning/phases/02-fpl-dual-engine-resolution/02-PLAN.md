---
phase: 2
plan: 1
name: FPL Dual-Engine Resolution
type: phase-plan
autonomous: false
depends_on:
  - 01-01-model-logic-consolidation
objectives:
  - Resolve FPL dual-engine situation (Sage vs Worker vs Unified)
  - Define clear contract/ownership for chosen approach
  - Update inference pipeline to reflect decision
---

# Phase 2 Plan: FPL Dual-Engine Resolution

## Objective

**Decide on FPL inference strategy and implement chosen approach.**

Currently, FPL predictions use two separate inference engines (Worker JS + Sage Python). This plan resolves that ambiguity by:
1. Gathering context on each option
2. Making a product decision
3. Implementing the chosen approach
4. Updating contracts/documentation

## Context

From Phase 1, we consolidated NBA/NHL/NCAAM logic. FPL remains separate with dual engines:
- **Worker-based:** JS prediction engine in `apps/worker/src/models/fpl.js`
- **Sage-based:** Python inference in separate Sage service

This creates maintenance burden and unclear ownership. Three viable paths forward.

## Decision Matrix

| Approach | Pros | Cons | Effort | Risk |
|----------|------|------|--------|------|
| **Option A: Replace Worker with Sage** | Single inference engine, Python consolidation, cleaner architecture | Requires Worker refactor, possible performance trade-off | Medium | Medium |
| **Option B: Keep Separate + Define Contract** | Minimal code changes, leverages existing strengths | More complex integration surface, dual maintenance | Low | Low |
| **Option C: Merge to Single JS** | All logic centralized, easier to extend, JS consistency | Large refactor, may lose Sage benefits | High | High |

## Phase 2 Plan Structure

### Stage 1: Decision (Checkpoint)
**Task 1.1:** Review each option with context
- Gather metrics: performance, maintenance, extensibility
- Clarify FPL role in future phases
- Make decision: A, B, or C

### Stage 2: Implementation (Based on Decision)

**If Option A (Replace with Sage):**
- Task 2.1: Build Sage → Worker API adapter
- Task 2.2: Port Worker FPL logic to Sage (or verify Sage already handles it)
- Task 2.3: Update inference pipeline
- Task 2.4: Deprecate Worker FPL engine

**If Option B (Keep Separate + Contract):**
- Task 2.1: Define API contract between Worker + Sage
- Task 2.2: Add interface enforcement (TypeScript/JSDoc boundaries)
- Task 2.3: Document ownership and maintenance guide
- Task 2.4: Create integration tests

**If Option C (Merge to Single JS):**
- Task 2.1: Port Sage FPL logic to Worker JS
- Task 2.2: Validate behavior equivalence
- Task 2.3: Update test suite
- Task 2.4: Deprecate Sage FPL component

### Stage 3: Validation
- Task 3.1: Verify chosen approach works end-to-end
- Task 3.2: Update Phase 2 details in STATE.md
- Task 3.3: Prepare Phase 3 (documentation) with new clarity

## Success Criteria

- [ ] FPL strategy chosen and documented in decision log
- [ ] Implementation completed for chosen approach
- [ ] All tests pass for new inference pipeline
- [ ] Contract/ownership clarified in comments/docs
- [ ] STATE.md updated with decision and next phase readiness

## Open Questions

1. **FPL priority:** Is FPL a core product or experimental?
2. **Performance:** Are there performance constraints between Sage vs Worker?
3. **Future:** Will FPL follow sports consolidation pattern (like NBA/NHL/NCAAM)?
