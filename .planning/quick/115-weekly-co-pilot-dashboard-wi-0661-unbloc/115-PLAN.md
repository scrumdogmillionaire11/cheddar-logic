---
phase: quick-115
plan: 115
type: execute
wave: 1
depends_on: []
files_modified:
  - web/src/lib/fpl-api.ts
  - web/src/components/fpl-dashboard.tsx
  - web/src/components/fpl-weekly-report-card.tsx
  - web/src/__tests__/fpl-weekly-report-card-contract.test.js
autonomous: true
requirements: [WI-0661]

must_haves:
  truths:
    - "Weekly dashboard renders pitch view (FPLLineupView), decision-card stack, and horizon timeline sections"
    - "Explainability blocks (why_this, why_not_alternatives, what_would_change) render from backend contract fields, never frontend-derived text"
    - "Uncertainty/relative_risk framing renders from backend contract fields, not hardcoded copy"
    - "Report-card component surfaces expected_vs_actual, missed_opportunities, captain_accuracy, transfer_quality, and profile_adherence"
    - "All three contract tests pass: fpl-dashboard-strategy, fpl-lineup-formation-contract, fpl-weekly-report-card-contract"
    - "npm --prefix web run build exits 0 with no TypeScript errors"
  artifacts:
    - path: "web/src/components/fpl-weekly-report-card.tsx"
      provides: "Report-card UI component"
      exports: ["default FPLWeeklyReportCard"]
    - path: "web/src/__tests__/fpl-weekly-report-card-contract.test.js"
      provides: "Source-level contract test for report card"
    - path: "web/src/lib/fpl-api.ts"
      provides: "Updated DetailedAnalysisResponse with explainability, relative_risk, weekly_report_card fields"
  key_links:
    - from: "web/src/components/fpl-dashboard.tsx"
      to: "FPLWeeklyReportCard"
      via: "import + props pass from data.*"
    - from: "web/src/components/fpl-dashboard.tsx"
      to: "data.explainability / data.relative_risk / data.confidence_band"
      via: "direct field access from DetailedAnalysisResponse"
---

<objective>
Implement the WI-0661 weekly co-pilot dashboard refresh: add explainability blocks, uncertainty/risk framing, and the trust/report-card UI surfaces to the existing dashboard. Create the missing `fpl-weekly-report-card.tsx` component and its contract test.

Purpose: The backend (WI-0657/WI-0658) now emits explainability, confidence_band, scenario_notes, relative_risk, and receipt-backed analytics. The UI must consume and surface these fields rather than deriving them from scratch. The report card surfaces backward-looking quality signals: captain accuracy, transfer quality, missed opportunities, and profile adherence.

Output:
- `fpl-api.ts` extended with additive fields on DetailedAnalysisResponse
- `fpl-dashboard.tsx` updated with explainability and relative_risk sections
- `fpl-weekly-report-card.tsx` — new report-card component
- `fpl-weekly-report-card-contract.test.js` — source-level contract test
</objective>

<execution_context>
@/Users/ajcolubiale/.claude/get-shit-done/workflows/execute-plan.md
@/Users/ajcolubiale/.claude/get-shit-done/templates/summary.md
</execution_context>

<context>
@.planning/STATE.md
@WORK_QUEUE/WI-0661.md

Relevant completed work:
- WI-0659 (quick-113): fpl-api.ts, fpl-product-shell.tsx — established append-only API client extension pattern and source-inspection contract test style
- WI-0660 (quick-114): 7 FPL workbench components — established 'use client' + Tailwind surface token pattern (border-white/10, bg-surface/80, text-cloud/60, text-teal, text-rose, text-amber)
- WI-0657 backend: adds confidence_band, scenario_notes, explainability (why_this, why_not_alternatives, what_would_change), relative_risk fields to weekly analysis payload
- WI-0658 backend: adds receipt-backed analytics (captain_accuracy, transfer_quality, missed_opportunities, profile_adherence) via UserAnalyticsResponse

<interfaces>
<!-- Key contracts the executor needs. Do not recreate ranking/explainability logic in the UI. -->

From web/src/lib/fpl-api.ts (existing, partial):
```typescript
// Already in DetailedAnalysisResponse (do NOT duplicate):
export interface DetailedAnalysisResponse {
  team_name: string;
  manager_name: string;
  current_gw?: number | null;
  primary_decision: string;
  confidence: 'HIGH' | 'MEDIUM' | 'LOW' | string;
  reasoning: string;
  starting_xi_projections: PlayerProjection[];
  bench_projections: PlayerProjection[];
  lineup_decision?: LineupDecisionPayload | null;
  projected_xi?: PlayerProjection[] | null;
  projected_bench?: PlayerProjection[] | null;
  chip_timing_outlook?: ChipTimingOutlook | null;
  fixture_planner?: FixturePlannerData | null;
  available_chips: string[];
  // ... (see full file)
}

// These DO NOT yet exist and must be added (Task 1):
// confidence_band, scenario_notes, explainability, relative_risk, weekly_report_card
```

Existing component patterns (from WI-0660):
- `'use client'` at top of stateful components
- Tailwind token palette: text-teal, text-rose, text-amber, text-cloud/60, bg-surface/80, border-white/10
- Source-level contract tests use `fs.readFile` + `assert.ok(source.includes(...))` — no runtime imports
- Test entry: `async function run() { ... } run().catch(...)` with `process.exit(1)` on failure
</interfaces>
</context>

<tasks>

<task type="auto">
  <name>Task 1: Extend fpl-api.ts with WI-0657/0658 additive fields</name>
  <files>web/src/lib/fpl-api.ts</files>
  <action>
    Add the following additive interfaces and fields to fpl-api.ts. Append ONLY — do not rename or remove any existing fields.

    New interfaces to add (append after ChipTimingOutlook interface ~line 194):

    ```typescript
    export interface ExplainabilityBlock {
      why_this?: string | null;
      why_not_alternatives?: string | null;
      what_would_change?: string | null;
      key_risk_drivers?: string[] | null;
    }

    export interface RelativeRiskBlock {
      rank_percentile?: number | null;
      ownership_safe_threshold?: number | null;
      recommended_risk_posture?: string | null;
      framing_note?: string | null;
    }

    export interface ConfidenceBand {
      lower?: number | null;
      upper?: number | null;
      label?: string | null;
    }

    export interface WeeklyReportCard {
      gameweek?: number | null;
      expected_pts?: number | null;
      actual_pts?: number | null;
      captain_accuracy?: string | null;
      transfer_quality?: string | null;
      missed_opportunities?: string[] | null;
      profile_adherence?: string | null;
      drift_flags?: string[] | null;
      verdict?: string | null;
    }
    ```

    Add these fields to DetailedAnalysisResponse (append after `squad_health?` line):
    ```typescript
      confidence_band?: ConfidenceBand | null;
      scenario_notes?: string[] | null;
      explainability?: ExplainabilityBlock | null;
      relative_risk?: RelativeRiskBlock | null;
      weekly_report_card?: WeeklyReportCard | null;
    ```
  </action>
  <verify>
    <automated>node -e "const fs=require('fs');const s=fs.readFileSync('web/src/lib/fpl-api.ts','utf8');['ExplainabilityBlock','RelativeRiskBlock','ConfidenceBand','WeeklyReportCard','confidence_band','scenario_notes','explainability','relative_risk','weekly_report_card'].forEach(k=>{if(!s.includes(k))throw new Error('Missing: '+k)});console.log('OK')"</automated>
  </verify>
  <done>All 9 new type/field identifiers present in fpl-api.ts. No existing fields removed or renamed.</done>
</task>

<task type="auto">
  <name>Task 2: Create fpl-weekly-report-card.tsx and its contract test</name>
  <files>web/src/components/fpl-weekly-report-card.tsx, web/src/__tests__/fpl-weekly-report-card-contract.test.js</files>
  <action>
    Create `web/src/components/fpl-weekly-report-card.tsx`:

    - Props: `{ reportCard: WeeklyReportCard | null | undefined }` — import WeeklyReportCard from '@/lib/fpl-api'
    - No 'use client' needed — pure display, no hooks
    - If reportCard is null/undefined, render null (no crash)
    - Render a rounded-xl border border-white/10 bg-surface/80 container with heading "Weekly Report Card"
    - Show gameweek if present: "GW{reportCard.gameweek}"
    - Show expected vs actual: expected_pts and actual_pts as "Expected: X pts / Actual: Y pts" — guard each with parseNumeric (null-safe)
    - Show captain_accuracy as a labeled row: "Captain accuracy:" + value (string from backend, not computed)
    - Show transfer_quality as a labeled row: "Transfer quality:" + value (string from backend, not computed)
    - Show missed_opportunities as a list if present and non-empty — heading "Missed opportunities"
    - Show profile_adherence as a labeled row: "Profile adherence:" + value
    - Show drift_flags as small chips if present and non-empty — heading "Drift flags"
    - Show verdict in a highlighted block if present: "Verdict:" + value
    - Use Tailwind tokens: text-teal for positive signals, text-rose for negative, text-amber for neutral/warnings, text-cloud/60 for labels, border-white/10, bg-surface/50

    Create `web/src/__tests__/fpl-weekly-report-card-contract.test.js`:

    Source-inspection test (no runtime component imports). Check that fpl-weekly-report-card.tsx:
    - imports WeeklyReportCard from '@/lib/fpl-api'
    - includes 'reportCard: WeeklyReportCard'
    - includes 'captain_accuracy'
    - includes 'transfer_quality'
    - includes 'missed_opportunities'
    - includes 'profile_adherence'
    - includes 'drift_flags'
    - includes 'expected_pts'
    - includes 'actual_pts'
    - includes 'Weekly Report Card'
    - does NOT include hardcoded captain accuracy computation logic (must not contain 'captainCorrect' or 'captainWrong')

    Also check fpl-api.ts:
    - includes 'export interface WeeklyReportCard'
    - includes 'captain_accuracy?: string | null'
    - includes 'transfer_quality?: string | null'
    - includes 'missed_opportunities?: string[] | null'
    - includes 'profile_adherence?: string | null'
    - includes 'weekly_report_card?: WeeklyReportCard | null'

    Test file follows the exact pattern from fpl-draft-coach-contract.test.js:
    - `async function run() { ... }` wrapping all assertions
    - `assert.ok(source.includes(...), 'descriptive message')`
    - `console.log('✅ FPL weekly report card contract test passed')`
    - `run().catch((error) => { console.error('❌ ...'); console.error(error.message || error); process.exit(1); })`
  </action>
  <verify>
    <automated>node web/src/__tests__/fpl-weekly-report-card-contract.test.js</automated>
  </verify>
  <done>fpl-weekly-report-card-contract.test.js passes with exit 0. Component file exists and imports WeeklyReportCard from fpl-api.</done>
</task>

<task type="auto">
  <name>Task 3: Update fpl-dashboard.tsx with explainability, relative_risk, and report-card wiring</name>
  <files>web/src/components/fpl-dashboard.tsx</files>
  <action>
    Update `web/src/components/fpl-dashboard.tsx` with three additive sections. Do NOT remove or restructure existing sections.

    1. Import FPLWeeklyReportCard at top:
       `import FPLWeeklyReportCard from '@/components/fpl-weekly-report-card';`
       Also add to the fpl-api import: `ExplainabilityBlock, RelativeRiskBlock`

    2. Add "Explainability" section — render after the Chip Timing Outlook section:
       - Section heading: "Decision Explainability"
       - Guard: only render if `data.explainability` is non-null
       - Render `data.explainability.why_this` as "Why this recommendation:" labeled row (null-guard)
       - Render `data.explainability.why_not_alternatives` as "Why not alternatives:" labeled row (null-guard)
       - Render `data.explainability.what_would_change` as "What would change this:" labeled row (null-guard)
       - Render `data.explainability.key_risk_drivers` as a bullet list if present and non-empty (null-guard with Array.isArray)
       - Do NOT compute or derive explainability text in the UI — render backend strings verbatim

    3. Add "Uncertainty and Risk Framing" section — render after Explainability section:
       - Section heading: "Uncertainty and Risk Framing"
       - Guard: only render if `data.confidence_band` or `data.relative_risk` is non-null
       - Render confidence_band.label if present: "Confidence band:" + label
       - Render relative_risk.recommended_risk_posture if present: "Risk posture:" + value
       - Render relative_risk.framing_note if present as a paragraph
       - Render scenario_notes as a list if data.scenario_notes is present and non-empty (guard with Array.isArray)
       - Do NOT compute risk posture from rank/ownership — render backend strings verbatim

    4. Render FPLWeeklyReportCard — insert at the bottom of the main content, before or after the fixture planner section:
       `<FPLWeeklyReportCard reportCard={data.weekly_report_card} />`

    Verify existing contract tests still pass:
    - 'Manager State', 'Near Threshold Moves', 'Strategy Paths', 'Structural Issues', 'Chip Timing Outlook' section headings must remain
    - 'captainDelta !== null' guard pattern must remain
    - 'Captain delta vs vice:' label must remain
    - lineupDecision={data.lineup_decision} prop pass must remain
  </action>
  <verify>
    <automated>node web/src/__tests__/fpl-dashboard-strategy.test.js && node web/src/__tests__/fpl-lineup-formation-contract.test.js && node web/src/__tests__/fpl-weekly-report-card-contract.test.js && npm --prefix web run build 2>&1 | tail -5</automated>
  </verify>
  <done>All three contract tests pass with exit 0. Build exits 0. Dashboard includes Decision Explainability and Uncertainty and Risk Framing sections. FPLWeeklyReportCard renders from data.weekly_report_card.</done>
</task>

</tasks>

<verification>
Run full suite after all tasks complete:

```
node web/src/__tests__/fpl-dashboard-strategy.test.js
node web/src/__tests__/fpl-lineup-formation-contract.test.js
node web/src/__tests__/fpl-weekly-report-card-contract.test.js
npm --prefix web run build
```

All four commands must exit 0.
</verification>

<success_criteria>
- fpl-api.ts has ExplainabilityBlock, RelativeRiskBlock, ConfidenceBand, WeeklyReportCard interfaces and corresponding optional fields on DetailedAnalysisResponse
- fpl-weekly-report-card.tsx exists, imports WeeklyReportCard from fpl-api, renders all 7 report-card surface fields without frontend computation
- fpl-dashboard.tsx has "Decision Explainability" and "Uncertainty and Risk Framing" sections that render verbatim backend strings only
- All three WI-0661 contract tests pass
- npm build exits 0
- WI-0661 acceptance criteria satisfied: pitch view + decision-card stack + timeline (already exist), explainability from backend contract (Task 3), trust/report-card UI (Task 2), existing tests remain green (Task 3 guard)
</success_criteria>

<output>
After completion, create `.planning/quick/115-weekly-co-pilot-dashboard-wi-0661-unbloc/115-SUMMARY.md` following the template at `@/Users/ajcolubiale/.claude/get-shit-done/templates/summary.md`.

Also update `WORK_QUEUE/WI-0661.md`:
- Set `CLAIM: [agent] [timestamp]`
- Add `**Status**: COMPLETE` block with commit hash and summary path once done.
</output>
