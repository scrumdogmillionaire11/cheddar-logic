# THE BOARD: Execution Roadmap

**Umbrella**: WI-0938  
**Status**: Ready for external agent assignment  
**Date**: April 24, 2026

---

## 📋 Requirements Sources

All work items reference these authoritative specifications:

- **Product Requirements**: [`docs/THE_BOARD_VALUE_ONE_PAGER.md`](docs/THE_BOARD_VALUE_ONE_PAGER.md)
- **Data Schema**: [`WORK_QUEUE/THE_BOARD_EDGE_SCHEMA_SPEC.md`](WORK_QUEUE/THE_BOARD_EDGE_SCHEMA_SPEC.md)

---

## 🚀 Execution Roadmap (7 Work Items)

### Phase 1: Planning & Architecture (WI-0938-01)

**Owner**: Unassigned  
**Duration**: 1-2 days  
**Scope**: Define architecture, feature flag strategy, integration points  
**Deliverable**: `.planning/phases/market-board/WI-0938-01-PLAN.md`  
**Blocks**: All downstream work

**Key Decisions**:
- Where does enricher function live? (Recommended: web API layer)
- Feature flag naming convention
- Phased delivery roadmap sign-off

---

### Phase 2: Page Skeleton + Feature Flag (WI-0938-02)

**Owner**: Unassigned  
**Duration**: 3-4 days  
**Depends on**: WI-0938-01  
**Scope**: Build `/board` route with empty tabs, feature flag infrastructure  
**Deliverables**: 
- `/board` route (feature-flagged)
- 3 empty tab components
- Mock API endpoints
- Navigation conditional rendering

**Unblocks**: WI-0938-03, 04, 05, 06 (can proceed in parallel)

---

### Phase 3: Tab Components (Parallel Work)

These three items can be built simultaneously once skeleton exists:

#### WI-0938-03: Opportunities Tab Component

**Owner**: Unassigned  
**Duration**: 3-4 days  
**Depends on**: WI-0938-02  
**Scope**: Build Opportunities card component  
**Deliverables**:
- `OpportunitiesTab.tsx`
- `OpportunityCard.tsx`
- `ActionStateBadge.tsx`
- `TriggerConditionsList.tsx`

---

#### WI-0938-04: Blocked Edges Tab Component

**Owner**: Unassigned  
**Duration**: 3-4 days  
**Depends on**: WI-0938-02  
**Scope**: Build Blocked Edges card component (trust builder)  
**Deliverables**:
- `BlockedEdgesTab.tsx`
- `BlockedEdgeCard.tsx`
- `UnlockConditionsList.tsx`

---

#### WI-0938-05: Edge Type Tracker Tab Component

**Owner**: Unassigned  
**Duration**: 2-3 days  
**Depends on**: WI-0938-02  
**Scope**: Build pattern performance tracker  
**Deliverables**:
- `EdgeTypeTrackerTab.tsx`
- `EdgeTypeCard.tsx`
- (Optional: chart/visualization)

---

### Phase 4: Backend Enrichment (WI-0938-06)

**Owner**: Unassigned  
**Duration**: 5-7 days  
**Depends on**: WI-0938-02 + WI-0938-01  
**Scope**: Implement enricher function + integration  
**Deliverables**:
- `compute-edge-reasoning.ts` (main enricher)
- `market-error-framing.ts`
- `edge-type-classifier.ts`
- `quality-score-formula.ts`
- `action-state-logic.ts`
- `trigger-system.ts`
- Real API endpoint implementation
- Settlement tracking for patterns

**Unblocks**: WI-0938-07 (final phase)

---

### Phase 5: Production Ready (WI-0938-07)

**Owner**: Unassigned  
**Duration**: 2-3 days  
**Depends on**: All prior items (02, 03, 04, 05, 06)  
**Scope**: Discord integration, feature flag removal, monitoring  
**Deliverables**:
- Discord formatter updates
- Production deployment checklist
- Onboarding guide
- Operator runbook
- Community announcement

---

## 📊 Timeline Overview

```
WI-0938-01 (PLAN)           [1-2 days]
    ↓
WI-0938-02 (SKELETON)       [3-4 days]
    ├─→ WI-0938-03 (OPPS)   [3-4 days] ⟹ ┐
    ├─→ WI-0938-04 (BLOCKED) [3-4 days] ⟹ ├─→ WI-0938-07 (PROD READY)
    ├─→ WI-0938-05 (TRACKER) [2-3 days] ⟹ ┤   [2-3 days]
    └─→ WI-0938-06 (ENRICHER) [5-7 days] ──┘

Total Sequential Path: ~18-22 days
Parallel Path (after skeleton): 7-8 days (items 03-06 overlap)
```

---

## 🔑 Key Implementation Principles

### 1. Skeleton First, Then Fill

- Build empty page structure and routing first (WI-0938-02)
- Tabs render with mock data
- Components built independently
- Real data integrated last (WI-0938-06)

### 2. Feature Flag Throughout

- `/board` accessible only when FEATURE_BOARD_ENABLED=true
- Nav link conditional
- Removed only in WI-0938-07

### 3. Backward Compatible

- All `edge_reasoning` fields optional
- Existing cards unaffected
- No breaking changes to APIs
- Graceful degradation if enricher unavailable

### 4. Deterministic Enrichment

- Quality Score is explainable formula, not black box
- Action State always FIRE/WAIT/PASS (no ambiguity)
- Market Error framing captures specific mistakes
- Trigger conditions are explicit and testable

### 5. Trust Through Transparency

- Blocked Edges tab shows strong edges we're NOT playing
- Unlock conditions make suppression logic visible
- Users learn model sensitivity
- Reinforces "no play is a play" philosophy

---

## 🎯 Scope Boundaries

### In Scope

- `/board` route and navigation
- Three tab components (Opportunities, Blocked Edges, Edge Type Tracker)
- Edge reasoning enricher function
- API endpoints for THE BOARD data
- Discord formatter updates
- Feature flag infrastructure
- Documentation + onboarding
- Performance monitoring

### Out of Scope

- Model formula changes
- Worker-side modifications
- Database schema changes
- Best Price / Movers tabs (v1 decision: focus on action clarity)
- Advanced charting/analytics (post-launch)
- Historical archive (current state only)

---

## 🧪 Testing Strategy

### Per Work Item

Each WI includes:
- Unit tests for new functions
- Integration tests for pipeline
- Manual validation checklist
- Build verification

### Pre-Launch (WI-0938-07)

- Full test suite passing
- Performance benchmarks validated
- Smoke tests on staging
- Discord bot tested
- Community announcement prepared

---

## 📚 Reference Materials

### For Agent

- **Product Brief**: `docs/THE_BOARD_VALUE_ONE_PAGER.md` (what users want)
- **Schema Spec**: `WORK_QUEUE/THE_BOARD_EDGE_SCHEMA_SPEC.md` (how data flows)
- **This Roadmap**: `WORK_QUEUE/WI-0938-ROADMAP.md` (how to execute)

### For Each Work Item

- WI-0938-01: Architecture guide (create during planning phase)
- WI-0938-02: Feature flag config examples
- WI-0938-03/04/05: Component mock data + design reference
- WI-0938-06: Enricher implementation guide (deterministic formulas)
- WI-0938-07: Deployment checklist + rollback plan

---

## ⚠️ Critical Success Factors

1. **Feature flag works** → Users don't see `/board` if not ready
2. **Enricher is deterministic** → Users understand quality scores
3. **Action states are clear** → No ambiguity (FIRE/WAIT/PASS only)
4. **Blocked edges build trust** → Show what we're NOT betting
5. **Performance acceptable** → API endpoints <500ms
6. **Zero regressions** → Existing card/wedge unaffected
7. **Community messaging clear** → Users understand value

---

## 🚨 Risk Mitigation

| Risk | Mitigation |
| --- | --- |
| Enricher breaks existing cards | All fields optional, graceful fallback tested |
| Performance degradation | Load testing before deployment |
| Users confused about action state | Clear labeling + onboarding guide |
| Feature flag forgotten in prod | Deployment checklist enforces |
| Discord formatter errors | Tested separately before integration |
| Blank edge_reasoning breaks UI | Components handle missing data |

---

## 📝 Next Steps

1. **Assign external agent** to WI-0938-01 (planning phase)
2. **Agent completes WI-0938-01**: architecture decision, feature flag strategy
3. **Assign multiple agents** to WI-0938-02 through WI-0938-06 (parallel after skeleton)
4. **Final assignment** to WI-0938-07 (integration + production)
5. **Launch** when all items complete

---

## 📞 Questions?

- **Product questions**: Reference `docs/THE_BOARD_VALUE_ONE_PAGER.md`
- **Schema questions**: Reference `WORK_QUEUE/THE_BOARD_EDGE_SCHEMA_SPEC.md`
- **Implementation questions**: Reference individual WI details + WI-0938-01 plan output

---

**Owner**: Cheddar Logic  
**Status**: Ready for Agent Assignment  
**Last Updated**: April 24, 2026
