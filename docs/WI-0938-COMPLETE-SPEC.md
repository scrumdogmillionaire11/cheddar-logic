# WI-0938: THE BOARD - Complete Specification Package

**Status**: Ready for External Agent Assignment  
**Date**: April 24, 2026  
**Umbrella Item**: WI-0938 (Market Board Program: The Wedge + The Board)

---

## 📦 What's Included

You now have a complete specification package for building THE BOARD. Everything is referenced and ready for an external agent to execute.

### 1. **Product Strategy** (What/Why)

📄 [`docs/THE_BOARD_VALUE_ONE_PAGER.md`](docs/THE_BOARD_VALUE_ONE_PAGER.md)

- **What**: THE BOARD is a market reasoning engine (not picks, not stats page)
- **Why**: Converts edge reasoning into clear action (FIRE/WAIT/PASS)
- **For Whom**: Traders, analytical learners, pattern recognizers
- **Success Metrics**: Action clarity, reduced churn, pattern learning, community engagement

**Key positioning**: "What's wrong in the market + what to do + why we're not acting"

---

### 2. **Data Architecture** (How Data Flows)

📄 [`WORK_QUEUE/THE_BOARD_EDGE_SCHEMA_SPEC.md`](WORK_QUEUE/THE_BOARD_EDGE_SCHEMA_SPEC.md)

- Complete TypeScript schema for `edge_reasoning` field
- Deterministic quality score formula
- Action state logic (FIRE/WAIT/PASS rules)
- Trigger system (unlock conditions)
- Integration points (decision-publisher, web API, Discord)
- Backward compatibility (all fields optional)

**Key constraint**: Quality score must be deterministic, not ML-based (users must understand it)

---

### 3. **Execution Roadmap** (How to Build)

📄 [`WORK_QUEUE/WI-0938-ROADMAP.md`](WORK_QUEUE/WI-0938-ROADMAP.md)

- 7 work items in 5 phases
- Skeleton-first approach (build page structure, then fill tabs)
- Feature flag throughout (safe launch)
- Parallel work opportunities (3 tabs can be built simultaneously)
- ~18-22 days total, ~7-8 days with parallelization

---

## 🎯 Work Items (Ready to Assign)

### Phase 1: Planning

**[WI-0938-01: Architecture + Feature Flag Strategy](WORK_QUEUE/WI-0938-01.md)**
- Creates `.planning/phases/market-board/WI-0938-01-PLAN.md`
- Defines where enricher function lives
- Documents feature flag strategy
- Blocks all downstream work
- **Duration**: 1-2 days

---

### Phase 2: Skeleton

**[WI-0938-02: Page Skeleton + Feature Flag](WORK_QUEUE/WI-0938-02.md)**
- Builds `/board` route (feature-flagged)
- Creates 3 empty tab components
- Sets up mock API endpoints
- Updates navigation
- **Duration**: 3-4 days
- **Unblocks**: Items 03-06 (parallel)

---

### Phase 3: Tab Components (Parallel)

**[WI-0938-03: Opportunities Tab Component](WORK_QUEUE/WI-0938-03.md)**
- Opportunity card display with action state badges
- Market error framing + trigger conditions
- Quality drivers checklist
- Pattern context reference
- **Duration**: 3-4 days

**[WI-0938-04: Blocked Edges Tab Component](WORK_QUEUE/WI-0938-04.md)**
- Trust-builder tab (show suppressed edges)
- Unlock condition display
- Why-blocked reasoning
- **Duration**: 3-4 days

**[WI-0938-05: Edge Type Tracker Component](WORK_QUEUE/WI-0938-05.md)**
- Pattern performance by edge type
- Hit rate, ROI, trend indicators
- Historical lookback display
- **Duration**: 2-3 days

---

### Phase 4: Backend Enrichment

**[WI-0938-06: Edge Reasoning Enricher + Integration](WORK_QUEUE/WI-0938-06.md)**
- Main enricher function (`computeEdgeReasoning`)
- Market error classifier
- Edge type classification
- Quality score formula
- Action state logic
- Trigger system
- Real data API population
- Settlement tracking
- **Duration**: 5-7 days

---

### Phase 5: Production Ready

**[WI-0938-07: Integration + Production Ready](WORK_QUEUE/WI-0938-07.md)**
- Discord formatter updates
- Feature flag removal
- Monitoring setup
- Onboarding guide
- Operator runbook
- Community announcement
- **Duration**: 2-3 days
- **Depends on**: All prior items

---

## 🎬 How to Hand Off to Agent

### Minimal Brief (Quick Start)

Give agent these three files:

1. [`docs/THE_BOARD_VALUE_ONE_PAGER.md`](docs/THE_BOARD_VALUE_ONE_PAGER.md) — Product requirements
2. [`WORK_QUEUE/THE_BOARD_EDGE_SCHEMA_SPEC.md`](WORK_QUEUE/THE_BOARD_EDGE_SCHEMA_SPEC.md) — Data schema
3. [`WORK_QUEUE/WI-0938-ROADMAP.md`](WORK_QUEUE/WI-0938-ROADMAP.md) — Execution plan

Then assign: **Start with WI-0938-01**

---

### Full Context Brief (Recommended)

Give agent:

1. This document (`docs/WI-0938-COMPLETE-SPEC.md` or similar)
2. All individual WIs (0938-01 through 0938-07)
3. The three source docs above
4. Background: current `/wedge` page structure (reference)
5. Background: Market Pulse API (reference)

Then assign: **Start with WI-0938-01**

---

### Agent Assignment Pattern

**Option A: Single Agent (Sequential)**
- WI-0938-01 → 02 → (choose one of 03/04/05) → 06 → 07
- Timeline: ~18-22 days

**Option B: Multiple Agents (Parallel)**
- Agent 1: WI-0938-01 (planning) → 02 (skeleton) → 07 (integration)
- Agent 2: WI-0938-03 (Opportunities tab)
- Agent 3: WI-0938-04 (Blocked Edges tab)
- Agent 4: WI-0938-05 (Edge Type Tracker tab)
- Agent 5: WI-0938-06 (enricher backend)
- Timeline: ~7-8 days in parallel (after skeleton)

---

## 🔧 Pre-Handoff Checklist

Before handing to agent, confirm:

- [ ] WI-0938 umbrella item updated with new scope + references
- [ ] WI-0938-01 through WI-0938-07 all created in WORK_QUEUE/
- [ ] Agent has access to GitHub repo
- [ ] Agent understands feature flag strategy (FEATURE_BOARD_ENABLED)
- [ ] Agent knows: quality score must be deterministic (not ML)
- [ ] Agent knows: no breaking changes to existing card/wedge flow
- [ ] Agent knows: backward compatibility required (all edge_reasoning optional)

---

## 🚀 Key Decision Points (For Agent)

### 1. Enricher Location

**Question**: Where does `computeEdgeReasoning()` function run?

**Options**:
- A: Web API layer (recommended) — clean separation, no worker changes
- B: Decision publisher in worker — but requires care with single-writer contract

**Recommendation**: Option A (web layer)

**Decided in**: WI-0938-01

---

### 2. Feature Flag Naming

**Question**: What environment variable name for the flag?

**Suggestion**: `FEATURE_BOARD_ENABLED` (or `NEXT_PUBLIC_FEATURE_BOARD_ENABLED` if client-side)

**Decided in**: WI-0938-01

---

### 3. Pattern Tracking Backend

**Question**: How to aggregate edge type performance?

**Options**:
- Query settlement data on-demand (slower, fresh)
- Cache aggregates with periodic refresh (faster, slightly stale)
- Stream updates as settlements occur (complex but real-time)

**Recommendation**: Cache with hourly refresh (good balance)

**Decided in**: WI-0938-06

---

## 📊 Success Criteria (Overall)

By the end of WI-0938-07, these must be true:

- [ ] `/board` route exists and is feature-flagged
- [ ] 3 tabs render: Opportunities, Blocked Edges, Edge Type Tracker
- [ ] Every opportunity has FIRE/WAIT/PASS state (no ambiguity)
- [ ] Blocked Edges show strong suppressed edges with unlock conditions
- [ ] Edge Type Tracker shows historical performance by type
- [ ] Discord messages include action state + market error
- [ ] Zero regressions in `/wedge` or existing card flow
- [ ] Feature flag is set to true in production
- [ ] Community messaging is clear (on Discord)
- [ ] Monitoring/alerts configured

---

## 🎯 Handoff Checklist for You

Before giving agent these materials:

1. **Review** the one-pager: Does it accurately capture product intent? ✓
2. **Review** the schema spec: Does it match your decision logic? ✓
3. **Review** individual WIs: Are scopes clear and non-overlapping? ✓
4. **Confirm** agent can access all referenced files
5. **Confirm** feature flag strategy (WI-0938-01 will decide)
6. **Confirm** rollback plan (WI-0938-07 will formalize)

---

## 📞 Common Questions (For Agent)

**Q: Do I need to change the worker?**  
A: No. Enricher lives in web layer only.

**Q: What if enricher fails?**  
A: Cards continue to work without `edge_reasoning` field (optional, backward compatible).

**Q: How long does enrichment take?**  
A: Should be <50ms per card (no complex ML, just classification + logic).

**Q: Can users see `/board` before it's ready?**  
A: No. Feature flag gates access (redirects to `/wedge` if not enabled).

**Q: Do I need to change Discord formatting?**  
A: Yes, but only for action state + market error (WI-0938-07).

**Q: What about best prices and movers tabs?**  
A: Out of scope for v1. Focus on Opportunities, Blocked Edges, Edge Type Tracker.

---

## 📝 Final Notes

- **This is locked**: All design decisions are final. No scope creep.
- **This is actionable**: Every WI has clear acceptance criteria and test commands.
- **This is backward compatible**: Existing functionality continues to work.
- **This is deterministic**: No black boxes in quality scoring or action logic.

Agent should feel confident handing this to implementation team.

---

**Created**: April 24, 2026  
**Status**: Ready for Agent Assignment  
**Next Step**: Assign to agent, start WI-0938-01
