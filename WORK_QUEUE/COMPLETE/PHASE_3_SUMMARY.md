# Phase 3 Work Items Summary

**Planning Session**: 2026-03-05
**Target Completion**: 2026-03-08 10:00
**Status**: 3 work items created, awaiting agent claims

---

## Quick Reference

| WI | Title | Effort | Window | Owner |
| --- | --- | --- | --- | --- |
| **WI-0306** | Edge Calculator Consolidation | 8h | 2026-03-06 09:00 → 2026-03-07 08:00 | unassigned |
| **WI-0307** | Multi-Model Variance Tracking | 8h | 2026-03-07 08:00 → 2026-03-08 06:00 | unassigned |
| **WI-0308** | Deterministic Filters & Payloads | 8h | 2026-03-07 11:00 → 2026-03-08 10:00 | unassigned |

## WI-0306: Edge Calculator Consolidation

**File**: [WI-0306.md](WI-0306.md)

**Problem**: `EdgeCalculator` and `FireCalculator` run in parallel, compute overlapping scores, and can disagree. This creates confusion and maintenance burden.

**Solution**: Merge into single `computeEdgeDecision()` that returns both scores with clear decision logic.

**Key Files Touched**:

- `apps/worker/src/models/edge-calculator.js` (consolidation point)
- `apps/worker/src/models/fire-calculator.js` (merge into edge)
- `web/src/app/api/games/route.ts` (expose edge_score + fire_score)
- `packages/data/src/validators/play-edge.js` (validation)
- `web/src/lib/game-card/card.test.ts` (update tests)

**Implementation Phases**: 9 (interface design → consolidation → validation → testing)

**Core Checklist**:

- [ ] Design collapsed interface: `computeEdgeDecision(play, snap) → {edge_score, fire_score, decision, metadata}`
- [ ] Consolidate fire logic into edge calculator
- [ ] Update validation schema to accept flat structure
- [ ] Expose both scores in API via `games/route.ts`
- [ ] Update card tests to work with new payload
- [ ] Write comprehensive edge-calculator test suite
- [ ] Verify 100% test coverage
- [ ] Document decision metadata format
- [ ] Clean up old fire-calculator file

**Tests to Run**:

```bash
npm --prefix apps/worker run test -- models/edge-calculator.test.js
npm --prefix web run test -- lib/game-card/card.test.ts
npm --prefix apps/worker run test -- src/__tests__/pipeline-odds-to-games.test.js
```

**Manual Validation**:

- Sample card payload includes both `edge_score` and `fire_score`
- Card selection logic correctly prioritizes FIRE when both present
- No errors in console when filtering/sorting cards

---

## WI-0307: Multi-Model Variance Tracking & Disagreement Metrics

**File**: [WI-0307.md](WI-0307.md)

**Problem**: When models disagree, there's no visibility into why. No metrics to track variance patterns.

**Solution**: Inject `model_version`, `disagrees_with`, `variance_reason` into play payload. Add UI badge + metrics dashboard.

**Key Files Touched**:

- `apps/worker/src/models/index.js` (inject metadata)
- `web/src/app/api/games/route.ts` (expose in API)
- `web/src/lib/game-card/disagreement-badge.tsx` (new UI component)
- `packages/data/src/validators/model-disagreement.js` (schema)
- `web/src/lib/game-card/card.test.ts` (update tests)

**Implementation Phases**: 8 (instrumentation → UI → validation → metrics → testing)

**Core Checklist**:

- [ ] Add model_version tracking in worker models
- [ ] Detect disagreement in edge vs. fire logic
- [ ] Categorize variance reasons (insufficient_data, threshold_boundary, model_mismatch, stale_snapshot)
- [ ] Create disagreement-badge component
- [ ] Add disagreement metadata to play payload
- [ ] Expose in API via games/route.ts
- [ ] Implement metrics tracking/dashboard endpoints
- [ ] Write comprehensive test suite
- [ ] Verify badge renders correctly in card UI

**Tests to Run**:

```bash
npm --prefix apps/worker run test -- models/disagreement-tracker.test.js
npm --prefix web run test -- lib/game-card/disagreement-badge.test.tsx
npm --prefix web run test -- app/api/games.test.ts
```

**Manual Validation**:

- Disagreement badge visible when edge ≠ fire
- Tooltip shows variance reason
- Metrics dashboard counts disagreements by sport/date
- No false positives (only reports actual mismatches)

---

## WI-0308: Deterministic Filters, Dynamic Presets & Debug Payloads

**File**: [WI-0308.md](WI-0308.md)

**Problem**:

- Quick filters sort non-deterministically (order changes across renders)
- Sport preset buttons hard-coded (show even when no cards for that sport)
- No goalie info in NHL plays (hard to debug)
- No recent games in Welcome Home card
- Pass reasons not categorized

**Solution**: Stabilize sorting, make presets dynamic, enrich payloads with debug info.

**Key Files Touched**:

- `web/src/lib/game-card/filters.ts` (deterministic sort)
- `web/src/lib/game-card/presets.ts` (dynamic from snapshot)
- `apps/worker/src/models/welcome-home-v2.js` (inject recent_games)
- `apps/worker/src/models/index.js` (NHL goalie fields)
- `web/src/app/api/games/route.ts` (flatten to API)

**Implementation Phases**: 9 (sorting → presets → timezone → welcome-home → goalie → API → categories → testing)

**Core Checklist**:

- [ ] Implement 3-tier sort: FIRE → WATCH → PASS, secondary by startTime
- [ ] Generate sport presets from snapshot.games (only if sport has ≥ 1 card)
- [ ] Hardcode "Next 4 hours" timezone to ET (America/New_York)
- [ ] Fetch last 3 games per team in welcome-home model
- [ ] Inject goalie_home_name, goalie_home_status (and away) into NHL plays
- [ ] Flatten goalie + recent_games into play JSON in API
- [ ] Categorize pass reasons: NO_VALUE, INSUFFICIENT_DATA, MODEL_NOT_RUN, OTHER
- [ ] Write filter test suite (including timeout/sort stability)
- [ ] Manual: verify sort order, preset buttons, timezone filtering, goalie names, recent games

**Tests to Run**:

```bash
npm --prefix web run test -- lib/game-card/filters.test.ts
npm --prefix web run test -- lib/game-card/presets.test.ts
npm --prefix apps/worker run test -- models/welcome-home-v2.test.js --testNamePattern="recent_games"
```

**Manual Validation**:

- FIRE plays render above WATCH in UI
- Sport preset buttons only visible for sports in snapshot
- "Next 4 hours" filter timezone correct (ET)
- NHL cards show goalie names
- Welcome Home recent_games array has 3 entries with dates

---

## Dependency & Coordination

### No Direct Dependencies

- **WI-0306** is foundational (consolidates decision logic)
- **WI-0307** depends on WI-0306 output interface
- **WI-0308** is independent (UI/payload only)

### Serialized Touchpoints (No Conflicts)

All three modify `web/src/app/api/games/route.ts` but add non-overlapping fields:

- **WI-0306**: adds `edge_score`, `fire_score`
- **WI-0307**: adds `model_version`, `disagrees_with`, `variance_reason`
- **WI-0308**: adds `recent_games`, `goalie_*`, `pass_reason_category`

**Strategy**: Each agent appends to the play object without modifying existing transforms.

---

## Execution Timeline

```text
DAY 1 (2026-03-06):
  09:00 - WI-0306 window opens (agent claims, starts implementation)

DAY 2 (2026-03-07):
  08:00 - WI-0306 window closes; WI-0307 window opens
  11:00 - WI-0308 window opens (WI-0307 still running)

DAY 3 (2026-03-08):
  06:00 - WI-0307 window closes (ready for review/merge)
  10:00 - WI-0308 window closes (Phase 3 target completion)
         - All three items should be merged or in final review
```

---

## Claim Instructions

To claim a work item:

1. Open the corresponding `.md` file (e.g., `WI-0306.md`)
1. Update the `Owner agent` field: `Owner agent: your-agent-name`
1. Add a claim line at the top:

```markdown
CLAIM: your-agent-name 2026-03-05T15:30:00Z
```

1. Open a pull request on a branch: `agent/your-agent-name/WI-0306-edge-consolidation`

Once claimed, only the listed work item owner may modify files in the work item's `Scope`.

---

## Review & Merge Criteria

Each work item PR must include:

- ✅ All tests passing (output included in PR description)
- ✅ Manual validation steps completed (checklist in PR)
- ✅ No files edited outside `Scope`
- ✅ Commit message format: `WI-####: <imperative summary>`
- ✅ Diff size reasonable (~300–500 LOC net per item)

---

## Phase 3 Success Metrics

- [ ] All 3 work items claimed by 2026-03-06 12:00
- [ ] WI-0306 merged by 2026-03-07 08:00
- [ ] WI-0307 and WI-0308 passing tests by 2026-03-08 10:00
- [ ] All changes documented in commit messages
- [ ] No breaking changes to public APIs (non-breaking additions only)
- [ ] Zero lint/format errors in all touched files
