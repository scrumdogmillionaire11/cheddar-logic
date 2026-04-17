Cheddar
Quick Filter Presets
- [ ] Main view should be Play + Lean
- [ ] Fire - Play
- [ ] What do the model lean indicators even mean?

Plays
- [ ] I want to see total projections for NHL on cards like we do for NBA, 
- [ ] we also need another spot on the card for 1p projections vs 1.5 line - no market data just projection
- [ ] Still seeing some cards MISSING Inputs - can we update variants with these teams?


Results
- [ ] Need holistic plan to ensure settliment is working in dev without messing up our prod settling data. Prod data can’t be fucked with….
- [ ] We need to decide HOW we settle if we have multiple plays for each game in the DB
    - [ ] The game presented on Cards is the game we track
- [ ] 

Non-total edges are still too large: Several spread plays show 25–35% edges, which usually signals a pricing or mapping problem and should trigger verification rather than a PLAY.
Proxy/fallback projections are being promoted to PLAY: Some cards rely on market-spread proxy or inferred values but are still treated as full plays instead of being capped to LEAN or PASS.
Driver loading is failing too often: Many games show “no driver plays loaded” or “driver load failed,” indicating gaps in the model or data pipeline rather than true betting passes.
PASS reasons are too broad: PASS_NO_QUALIFIED_PLAYS is masking multiple issues (missing data, driver failure, no edge), making debugging harder.
Some PASS cards still show strong edges: Plays with 9–12% edges are being blocked due to support thresholds, which is valid but not clearly explained in the UI.
Fallback proxy spreads are leaking into edge math: When the system substitutes a market spread as a proxy, the resulting edge calculation becomes unreliable.
Internal verdict labels are leaking into the UI: Terms like “COTTAGE” or “CHEDDAR” appear to be internal classification labels that aren’t meaningful to users.
Spread projections lack margin context: The card shows a team projection number but doesn’t display the projected winning margin that justifies the spread bet.
Totals logic appears thin in some sports: NHL totals are sometimes driven by only one or two lightweight indicators (like pace), reducing confidence in those signals.
LEAN tier definition is still fuzzy: Some LEAN plays look like small edges while others look like capped plays, suggesting the threshold rules for LEAN aren’t fully consistent yet.


Yes. The good news is you probably do **not** need a brand-new projection system — you need to **tighten, standardize, and expose** the one you already have.

## What I’d do

### 1) Pick one canonical formula per sport

Right now “we have two NBA formulas” is how drift sneaks in.

Use:

* **NBA:** `projectNBACanonical()` as the source of truth
* **NCAAM:** `projectNCAAM()` as the source of truth
* everything else should either feed those or be retired from display-facing logic

Rule:

* only one function is allowed to produce the projection used for card display, edge context, and spread/total pricing

---

### 2) Standardize projection outputs

Every projection function should return the same shape:

* `home_projected_score`
* `away_projected_score`
* `projected_margin_home`
* `projected_total`
* `projection_confidence`
* `projection_inputs_complete` = true/false
* `missing_inputs[]`

That way UI and decision logic stop guessing what a projection means.

---

### 3) Never show a naked `Projection: 82`

That’s the current crime scene.

For spread cards, always render:

* `Projected score: Home 82, Away 79`
* `Projected margin: Home -3.0`
* `Market spread: Home -1.5`
* `Line delta: +1.5`

For totals:

* `Projected total: 161.0`
* `Market total: 157.5`
* `Line delta: +3.5`

If you can’t compute those fields, don’t pretend the projection is usable.

---

### 4) Add projection validity gates

If required inputs are missing, projection should not partially masquerade as real.

For each sport:

#### NBA required inputs

* team offense
* team defense
* pace
* home/away split inputs if used
* rest adjustment inputs if used

#### NCAAM required inputs

* home offense
* away defense
* away offense
* home defense
* home-court adjustment

If any critical input is missing:

* `projection_inputs_complete = false`
* return nulls for market-facing context
* attach specific reasons, like:

  * `MISSING_OFFENSE_METRIC`
  * `MISSING_DEFENSE_METRIC`
  * `MISSING_PACE`
  * `MISSING_REST_INPUT`

---

### 5) Separate raw projection from market adjustment

Do not mix “our projection” and “market line” too early.

Compute in this order:

1. raw projected scores
2. raw projected margin / total
3. market comparison
4. edge math

That keeps you from accidentally echoing the market back as if it were your model.

---

### 6) Make line delta explicit

For spread:

* `line_delta = projected_margin_for_called_side - market_spread_threshold`

For total:

* `line_delta = projected_total - market_total`

This is crucial because:

* `edge_pct` tells you price value
* `line_delta` tells you model distance from the number

You need both.

---

### 7) Add sanity bounds

Projection functions should fail gracefully if they produce garbage.

Examples:

* NBA projected team score outside, say, `75–145` → warn/block
* NCAAM projected total outside `110–190` → warn/block
* projected margin above a reasonable threshold for the sport → flag

Not auto-delete, but definitely log and possibly downgrade.

---

### 8) Calibrate uncertainty, not just point estimate

A big part of your edge comes from sigma assumptions.

You already have sigma defaults. Good. Now tie them to:

* sport
* market
* maybe confidence tier / missing-input quality later

At minimum:

* keep `projected_margin` and `projected_total` separate from the probability conversion
* log which sigma was used to derive `p_fair`

Because if the sigma is wrong, the edge explodes.

---

### 9) Add a projection audit row in debug mode

For each displayed play, be able to inspect:

* formula used
* raw projected home score
* raw projected away score
* projected margin
* projected total
* market line
* line delta
* sigma used
* inputs missing? yes/no

That will make debugging way faster than staring at “Projection: 82” and guessing.

---

## Practical requirements I’d lock in

### Canonical projection contract

Each sport projection module must output:

```text
{
  home_projected_score: number | null,
  away_projected_score: number | null,
  projected_margin_home: number | null,
  projected_total: number | null,
  projection_inputs_complete: boolean,
  missing_inputs: string[],
  formula_id: string
}
```

### Spread display contract

A spread card must not render as fully explained unless it has:

* projected margin
* market spread
* line delta

### Total display contract

A total card must not render as fully explained unless it has:

* projected total
* market total
* line delta

### Missing-data rule

If projection context is incomplete:

* no fake context row
* no naked single-number projection
* downgrade confidence or pass as needed

---

## My blunt take

Your projection math likely exists already. The real problems are:

* too many incomplete inputs
* inconsistent output shape
* poor display translation
* not enough auditability

So yes — the move is not “invent more model.”
It’s “make projections canonical, structured, and impossible to misuse.”

Paste the current projection output shape you’re getting for one NBA spread card and one NCAAM spread card, and I’ll help you normalize it.


## Plan: Legacy Removal

We will remove legacy parsing and inference paths across worker, web, and settlement so the UI and decision pipeline rely solely on `decision_v2` and structured projection fields. This aligns with your “no unnecessary new” requirement and the acceptance that old cards can degrade. The core idea is to delete heuristic fallbacks (status/classification parsing, market inference, projection parsing from notes), then ensure the worker emits complete structured projection data for wave1 cards so the UI still renders context. Settlement will drop the historical fallback flow and depend only on locked market keys.

**Steps**
1. **Audit and lock the canonical contract**  
   Confirm worker play payloads always include `decision_v2`, `action`, `classification`, `market_type`, and structured projections used by UI. Verify wave1 projections are populated for SPREAD/TOTAL in run_nhl_model.js, run_nba_model.js, run_mlb_model.js, and the projection functions in projections.js.
2. **Remove legacy status/classification fallbacks in UI**  
   Delete legacy parsing from decision.ts and canonical-decision.ts so decisions derive only from `decision_v2` and explicit `action`. Update tags.ts and filters.ts to stop using expression choice and driver-tier fallbacks when play/action is missing.
3. **Remove legacy market inference and projection parsing**  
   Eliminate note/title inference and regex parsing in decision.ts and legacy market inference in transform.ts. Also remove legacy normalization in route.ts that infers market/projection/model prob from non-canonical fields.
4. **Remove legacy risk/tag heuristics (note/title scanning)**  
   Rely on `decision_v2` reason codes and tags only; remove text scanning in decision.ts and tags.ts. Keep explicit tags emitted by the worker.
5. **Retire historical settlement fallback**  
   Remove the legacy settlement fallback path in resettle_historical_cards.js and document that re‑settlement is no longer supported for legacy payloads. Settlement remains based on locked market keys in settle_pending_cards.js.

**Verification**
- Run web decision tests covering canonical decision and play display logic.
- Run worker decision pipeline tests (`decision-publisher.v2` and settlement contract tests).
- Manual: open cards page, confirm projection context renders only when structured projection fields are present; old cards may show reduced context as expected.

**Decisions**
- Immediate removal of legacy paths across worker, web, and settlement.
- Old cards may degrade in display; we will not preserve legacy rendering.



## Plan: Holistic Notes Alignment (Final Tightened)

This version locks the canonical payload contract and pass‑reason vocabulary up front, enforces exact‑wager validation, and gates legacy removal by per‑market completeness validated by tests + sample slate audit. It keeps projections model‑only, clarifies proxy rendering limits, and formalizes 1P as projection‑only. No new systems are introduced.

**Steps**
1. **Canonical priced payload contract (explicit, written)**  
   Required fields for every priced wave‑1 card: `decision_v2`, `market_type`, `market_side`, `market_line`, `market_price`, `p_fair`, `p_implied`, `edge_pct`, plus `pricing_trace` containing `price_source` and `line_source`. Update enforcement in decision-pipeline-v2.js and emission in decision-publisher.js.
2. **Exact‑wager validation is mandatory**  
   Pricing/display depends on exact `market_type + market_side + market_line + market_price` with no cross‑market borrowing. Keep this enforced in decision-pipeline-v2.js.
3. **Projection contract (uniform + model‑only)**  
   All sports emit the same projection shape: `home_projected_score`, `away_projected_score`, `projected_margin_home`, `projected_total`, `projection_confidence`, `projection_inputs_complete`, `missing_inputs`, `formula_id`. `projected_total` and `projected_margin_home` must come only from model outputs, never from market lines. Implement in projections.js and emitting jobs apps/worker/src/jobs/run_nba_model.js run_nhl_model.js.
4. **Proxy behavior (explicit rendering limits)**  
   Proxy/inferred outputs may render directional opinion + projection context only; they may not render priced edge math or PLAY status. Enforce via `proxy_capped` and reason codes in decision-pipeline-v2.js.
5. **Pass‑reason vocabulary lock (finite list)**  
   Define the allowed pass reason codes in writing and enforce in decision-pipeline-v2.js; UI renders only those in decision.ts.
6. **Completeness gate for legacy removal**  
   Legacy fallbacks removed per market only after: (a) automated tests pass and (b) sample slate audit meets coverage thresholds for each sport/market. Gate changes in apps/worker/src/jobs/run_nba_model.js run_nhl_model.js.
7. **UI projection context + line delta from structured fields**  
   Render margin/total + line delta only when structured fields are present in cards-page-client.tsx and transform.ts. Update presets and Lean explanation in presets.ts.
8. **1P market contract (projection‑only)**  
   Keep 1P totals as projection‑only (no priced market fields), enforced in index.js and verified in nhl-1p-totals.test.js.
9. **Settlement rule for legacy cards**  
   Legacy payloads without locked market keys are unsupported for settlement; no heuristic settlement. Enforce in settle_pending_cards.js and retire legacy re‑settlement in resettle_historical_cards.js.

**Verification**
- Worker: decision_v2 pipeline tests + per‑market completeness tests.
- Web: transform/decision tests to confirm no legacy fallbacks for gated markets.
- Manual: sample slate audit per market with coverage thresholds before fallback removal.

**Decisions**
- Use `market_side` in the canonical contract.  
- `pricing_trace` must include `price_source` and `line_source`.  
- Projections are model‑only; never derived from market lines.  
- Proxy cards show projection context only, not priced edge math.  
- Pass reasons and pricing trace fields are locked before implementation.


## Plan: Root Cause for Missing Data (Consistent Data Flow)

We will fix missing data by enforcing a deterministic pipeline contract with explicit stage checkpoints, locked reason codes, and fast‑fail rules. This focuses on mapping, odds, inputs, drivers, and publish staging so every game either yields a valid card or a precise failure reason. No new systems; use existing worker/data packages and decision_v2 metadata to carry reasons.

**Steps**
1. **Define a pipeline stage contract (per game)**  
   Add a canonical per‑game pipeline state structure in worker output and logs: `ingested`, `team_mapping_ok`, `odds_ok`, `market_lines_ok`, `projection_ready`, `drivers_ready`, `pricing_ready`, `card_ready`, `blocking_reason_codes`. Emit it alongside run summaries in main.js and model jobs like apps/worker/src/jobs/run_nba_model.js.
2. **Lock reason codes by stage (finite list)**  
   Define a strict reason code vocabulary for each failure stage in decision-pipeline-v2.js and pass them through decision-publisher.js to UI. Eliminate generic “drivers unavailable.”
3. **Canonical team mapping normalization**  
   Add/expand alias normalization in the data layer (team name resolution) and fail fast if unmapped. Use packages/data/src/normalize and odds ingestion paths (odds enrichment in packages/data/src/odds-enrichment) to resolve `home/away` IDs before model input extraction.
4. **Per‑market availability checks**  
   For each game, explicitly compute availability by market (`ml`, `spread`, `total`, `team_total`, `1p`) and price readiness before model/price decisions. Implement in market decision flow (cross‑market decisions in cross-market.js) and propagate to decision_v2 fields.
5. **Projection completeness gates**  
   Enforce required inputs per sport; if missing, stop projection and tag missing inputs. Implement in projections.js and ensure drivers don’t run without `projection_inputs_complete`.
6. **Driver attempt + failure reporting**  
   Each driver should report `attempted`, `eligible`, `blocked_reason`. Aggregate into the per‑game pipeline state in index.js so driver load failures are explicit.
7. **Staged publishing**  
   Only publish cards after pipeline state is consistent (no partial publish mid‑run). Wire into job flow in apps/worker/src/jobs/run_*_model.js and scheduler orchestration in main.js.

**Verification**
- Run model jobs with sample slates and confirm per‑game pipeline state is present and reason codes are specific.
- Validate that UI shows specific failure reasons instead of generic “drivers unavailable.”
- Check that unmapped teams and missing inputs are reported before driver/pricing stages.

**Decisions**
- Every game must end in “card_ready” or an explicit stage reason code.
- Team mapping failures are hard stops, not soft fallbacks.
- Projections and drivers do not run without required inputs.
