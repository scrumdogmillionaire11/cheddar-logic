# FPL Sage 2.0 — Agent Development Brief

## Context Layer: `fpl-sage-context-v2.tsx` → Full Decision Engine Integration

Generated: 2026-02-23
File: `/Users/ajcolubiale/projects/cheddar-fpl-sage/frontend/src/fpl-sage-context-v2.tsx` (or Dashboard.tsx integration point)

---

## CURRENT STATE (what exists and works)

The context layer is **structurally complete** as a standalone component.
Copilot's last patch added controlled/uncontrolled props, fixed the chip-summary bug,
and exposed `FPLSageContextLayer` as a named export. The file now has:

✅ `RISK_POSTURE_MAP` with typed thresholds (transferGainFloor, hitNetFloor, maxHitsPerGW,
  chipDeployBoost, captainDiffMaxOwnership, bbMinBenchXPts, tcRequiresDGW)
✅ Chip multi-select (wildcard, bench_boost, triple_captain, free_hit)
✅ Injury overrides (player, status, chance%)
✅ Transfer intent planner (scaffolded)
✅ Risk posture selector with expandable behavior rules
✅ ReasoningPanel — derives decisions from context state
✅ Summary bar with live verdict
✅ Controlled/uncontrolled mode via value/onChange props
✅ Dashboard.tsx integration guide in file comments

---

## THE GAP — What Still Needs to Be Built

### 1. WIRE INTO Dashboard.tsx (PRIORITY 1) — DONE

The component exists. It needs to actually live in the dashboard.

**Completed:**

- `FPLSageContextLayer` is imported and rendered in `Dashboard.tsx`
- `fplCtx` + `showFplReasoning` state wired via controlled props
- Header now uses live data (`results.current_gw`, `results.generated_at`)
- Component placed below the decision banner (Analysis Results section)

**State shape to add to Dashboard:**

```ts
const [fplCtx, setFplCtx] = useState({
  freeTransfers: 1,
  chips: [],
  riskPosture: 'balanced',
  benchPoints: 0,
  injuries: [],
  transferIntent: [],
  planningNotes: '',
  rankChasing: false,
});
const [showFplReasoning, setShowFplReasoning] = useState(false);
```

---

### 2. CONNECT CONTEXT TO API CALL (PRIORITY 1) — PARTIAL

The context thresholds are computed but never sent to the backend.
Every time the user triggers a refresh or analysis, the payload must include context.

**In the existing `GET /api/fantasy/fpl-sage` call, add these query params:**

```ts
// Build enriched payload from context
import { RISK_POSTURE_MAP } from './fpl-sage-context-v2';

const postureThresholds = RISK_POSTURE_MAP[fplCtx.riskPosture].thresholds;

const apiPayload = {
  freeTransfers:    fplCtx.freeTransfers,
  availableChips:   fplCtx.chips,
  riskPosture:      fplCtx.riskPosture,
  injuryOverrides:  fplCtx.injuries,   // [{player, status, chance}]
  transferIntent:   fplCtx.transferIntent,
  rankChasing:      fplCtx.rankChasing,
  // Pass thresholds directly so backend chip optimizer uses them:
  thresholds:       postureThresholds,
};

// POST to backend (or add as query params if staying GET):
const res = await fetch('/api/fantasy/fpl-sage', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(apiPayload),
});
```

**Backend (`server/index.js`) needs to:**

- Accept POST body on `/api/fantasy/fpl-sage`
- Pass `injuryOverrides` into the FPL Sage API call (already supported by FPL Sage backend)
- Pass `thresholds` + `riskPosture` into the chip optimizer (`fpl-chip-optimizer.js`)
- Return chip optimizer results merged into the existing sage response

**Status:**

- Frontend `createAnalysis` now includes `thresholds`, `risk_posture`, `available_chips`, and `injury_overrides` (from `fplCtx`).
- Backend changes still pending (no `server/index.js` in this repo; current backend is FastAPI under `/backend`).

---

### 3. CHIP OPTIMIZER INTEGRATION (PRIORITY 2) — NOT STARTED

The chip optimizer (`fpl-chip-optimizer.js`) exists as a standalone Node module.
It needs to be called server-side as part of the `/api/fantasy/fpl-sage` response.

**In `server/index.js`:**

```js
const { runChipOptimizer } = require('./fpl-chip-optimizer');

// After getting sage analysis:
const chipResult = runChipOptimizer({
  availableChips: req.body.availableChips || [],
  squad: transformSageSquad(sageAnalysis),  // map sage response → optimizer squad shape
  gwContext: buildGWContext(sageAnalysis),  // extract DGW/BGW from fixture data
  lookAheadFixtures: [],                   // optional — add if fixture data available
});

// Merge into response:
response.chipOptimizer = chipResult;
```

**The squad transformer (`transformSageSquad`) needs to map:**

- `sageAnalysis.transferTargets` → starters array with xPts, form, fixtureRating, injuryStatus
- `sageAnalysis.weaknesses` → bench array equivalent
- Apply `injuryOverrides` from context BEFORE passing to optimizer (overrides trump API)

---

### 4. DISPLAY CHIP OPTIMIZER RESULTS IN CONTEXT LAYER (PRIORITY 2) — NOT STARTED

Once the API returns `chipOptimizer` data, the ReasoningPanel should:

- Replace its mock chip guidance with real optimizer scores
- Show score bars (0-100) per chip
- Show DEPLOY / MONITOR / HOLD recommendations from the engine
- Show `optimalGW` and `reasons` from the optimizer output

**Add to `FPLSageContextLayer` props:**

```ts
chipOptimizerResult?: {
  chipsEvaluated: Array<{
    chip: string;
    score: number;
    recommendation: 'DEPLOY' | 'MONITOR' | 'HOLD';
    headline: string;
    reasons: string[];
    risks: string[];
    optimalGW: number;
  }>;
  summary: { verdict: string; message: string; };
}
```

**In `ReasoningPanel`, replace `deriveChipGuidance(context)` call:**

```ts
const chipGuidance = chipOptimizerResult?.chipsEvaluated ?? deriveChipGuidance(context);
// deriveChipGuidance stays as fallback when API result is unavailable
```

---

### 5. PERSIST CONTEXT ACROSS SESSIONS (PRIORITY 3) — NOT STARTED

User should not have to re-enter free transfers, chips, and injury overrides every session.

**Use localStorage:**

```ts
// On mount: hydrate
const [fplCtx, setFplCtx] = useState(() => {
  try {
    const saved = localStorage.getItem('fpl-sage-context');
    return saved ? { ...DEFAULT_CONTEXT, ...JSON.parse(saved) } : DEFAULT_CONTEXT;
  } catch { return DEFAULT_CONTEXT; }
});

// On change: persist (debounced)
useEffect(() => {
  const t = setTimeout(() => {
    localStorage.setItem('fpl-sage-context', JSON.stringify(fplCtx));
  }, 500);
  return () => clearTimeout(t);
}, [fplCtx]);
```

**What to persist:** freeTransfers, chips, riskPosture, benchPoints, injuries, transferIntent, planningNotes, rankChasing
**What NOT to persist:** reasoning panel open/closed state, pulse animation state

---

### 6. TRANSFER INTENT PLANNER — COMPLETE THE SCAFFOLD (PRIORITY 3) — NOT STARTED

The `TransferIntentPlanner` component is scaffolded but not fully implemented.

**It needs:**

- OUT player selector (text input or dropdown from squad)
- IN player target (text input — name + team + position + cost)
- Priority selector: URGENT / PLANNED / CONSIDERING
- Auto-generates a reasoning string: "Transfer [OUT] → [IN] because [reason]"
- This gets sent in `transferIntent` array to backend
- Backend surfaces it in the recommendation alongside FPL Sage's own targets
- UI shows intent vs. FPL Sage recommendation side-by-side for comparison

**Data shape:**

```ts
transferIntent: Array<{
  out: string;       // player name
  in: string;        // player name
  reason: string;    // free text
  priority: 'URGENT' | 'PLANNED' | 'CONSIDERING';
}>
```

---

### 7. CAPTAIN MODEL SIGNAL FUSION IN REASONING PANEL (PRIORITY 3) — NOT STARTED

The captain model (`external-model` returning confidence-scored picks) is fetched
separately but not yet integrated into the ReasoningPanel's captain section.

**Add to `FPLSageContextLayer` props:**

```ts
captainModelData?: {
  recommendations: Array<{
    player: string;
    action: 'captain' | 'vice-captain' | 'differential-captain';
    confidence: number;
    reasoning: string;
    priority: 'high' | 'medium' | 'low';
  }>;
}
```

**In ReasoningPanel, add a `CaptainSignalFusion` section:**

- List top 3 captain recommendations from captain model
- For each, cross-reference against FPL Sage's captain pick
- Flag "✓ both models agree" when they match
- Apply risk posture: conservative = suppress differentials, aggressive = highlight them
- Show fused confidence score: `(captainModel.confidence + sage.captainConfidence * 100) / 2`

---

## WHAT COPILOT SHOULD NOT TOUCH

1. **`RISK_POSTURE_MAP`** — The threshold values are deliberate. Do not change defaults.
2. **`deriveChipGuidance()`** — Keep as fallback. Add real results as override, don't replace.
3. **The controlled/uncontrolled pattern** — Already correct. Don't refactor.
4. **The pulse animation** — Keep. It gives visual feedback that reasoning re-evaluated.

---

## SUGGESTED NEXT PROMPT FOR COPILOT

```text
Priority 1: Wire FPLSageContextLayer into Dashboard.tsx.

1. Add fplCtx state and showFplReasoning state to Dashboard.
2. Import FPLSageContextLayer and RISK_POSTURE_MAP from fpl-sage-context-v2.jsx.
3. Place the component in the FPL section below the decision banner.
4. Pull gameweek and deadline from sageData (the existing FPL Sage API response).
5. Upgrade the existing /api/fantasy/fpl-sage fetch to POST, and include the 
   enriched payload: { freeTransfers, availableChips, riskPosture, injuryOverrides, 
   thresholds: RISK_POSTURE_MAP[fplCtx.riskPosture].thresholds }.
6. Do not add new UI elements. Do not change existing Dashboard layout.
   Only wire what exists.
```

---

## FILE DEPENDENCIES MAP

```text
Dashboard.tsx
  └── FPLSageContextLayer (fpl-sage-context-v2.jsx)
        ├── RISK_POSTURE_MAP          [constants — exported]
        ├── DEFAULT_CONTEXT           [constants]
        ├── deriveChipGuidance()      [reasoning fallback]
        └── ReasoningPanel
              ├── props: chipOptimizerResult  [from API — Priority 2]
              └── props: captainModelData     [from captain model — Priority 3]

server/index.js
  ├── GET/POST /api/fantasy/fpl-sage
  │     ├── fpl-sage-client.js        [FPL Sage API polling — exists]
  │     ├── fpl-chip-optimizer.js     [chip scoring — exists, not yet wired]
  │     └── context payload → injuryOverrides, thresholds, riskPosture
  └── GET /api/fantasy/fpl (original analyzer — keep as fallback)
```

---

## DONE WHEN

- [x] `FPLSageContextLayer` renders inside `Dashboard.tsx` with live GW/deadline data
- [ ] Context state persists in localStorage across page reloads
- [x] API POST includes thresholds + injury overrides from context
- [ ] API response includes `chipOptimizer` results
- [ ] ReasoningPanel shows real chip scores, not derived-only guidance
- [ ] Transfer intent planner is functional (add/remove planned transfers)
- [ ] Captain model signals appear in reasoning panel with posture-adjusted weight

## NOTES / WHERE I LEFT OFF

- Context layer moved to `frontend/src/fpl-sage-context-v2.tsx` and exported `RISK_POSTURE_MAP` + thresholds.
- Dashboard now uses a single `fplCtx` state and passes it to the context layer (controlled props).
- Frontend analysis payload includes `thresholds` (typed in `frontend/src/lib/api.ts`).
- Backend endpoint update is still required; current backend is FastAPI under `/backend` (not a Node `server/index.js`).
