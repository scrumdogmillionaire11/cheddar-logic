---
phase: quick
plan: 112
type: execute
wave: 1
depends_on: []
files_modified:
  - cheddar-fpl-sage/backend/models/draft_analysis_api_models.py
  - cheddar-fpl-sage/backend/services/draft_audit.py
  - cheddar-fpl-sage/backend/services/draft_compare.py
  - cheddar-fpl-sage/backend/routers/draft_analysis.py
  - cheddar-fpl-sage/backend/routers/__init__.py
  - cheddar-fpl-sage/backend/main.py
  - cheddar-fpl-sage/tests/test_draft_audit.py
  - cheddar-fpl-sage/tests/test_draft_compare.py
  - cheddar-fpl-sage/tests/test_draft_analysis_api.py
autonomous: true
requirements: [WI-0656]

must_haves:
  truths:
    - "POST /api/v1/draft-sessions/{id}/audit returns all 8 structured audit dimensions"
    - "POST /api/v1/draft-sessions/compare accepts two squad/session references and returns a winner with delta summary"
    - "Audit output is profile-aware: same squad produces materially different commentary under different archetypes"
    - "Comparison explains tradeoffs in prose rather than returning a raw numeric winner only"
    - "Audit outputs are deterministic and structured (not an opaque single grade)"
  artifacts:
    - path: "cheddar-fpl-sage/backend/models/draft_analysis_api_models.py"
      provides: "Pydantic models for audit request/response and compare request/response"
    - path: "cheddar-fpl-sage/backend/services/draft_audit.py"
      provides: "score_audit() — profile-aware scoring across 8 dimensions"
    - path: "cheddar-fpl-sage/backend/services/draft_compare.py"
      provides: "compare_drafts() — winner determination + per-dimension delta summary"
    - path: "cheddar-fpl-sage/backend/routers/draft_analysis.py"
      provides: "FastAPI router with /audit and /compare endpoints"
  key_links:
    - from: "routers/draft_analysis.py"
      to: "services/draft_audit.py"
      via: "score_audit(build, archetype)"
    - from: "routers/draft_analysis.py"
      to: "services/draft_compare.py"
      via: "compare_drafts(build_a, build_b, archetype)"
    - from: "main.py"
      to: "routers/draft_analysis.py"
      via: "app.include_router(draft_analysis_router)"
---

<objective>
Implement WI-0656: draft audit scoring and comparison APIs.

Purpose: Gate WI-0659 (Next.js FPL product shell). Provides the analytical backbone for the draft coach UI — managers can score a draft against their profile and compare two alternative squads to understand which wins on upside, safety, flexibility, and fit.

Output: Two new endpoints under /api/v1/draft-sessions, three test files, models, two services, and main.py registration.
</objective>

<execution_context>
@/Users/ajcolubiale/.claude/get-shit-done/workflows/execute-plan.md
@/Users/ajcolubiale/.claude/get-shit-done/templates/summary.md
</execution_context>

<context>
@/Users/ajcolubiale/projects/cheddar-logic/.planning/STATE.md
@/Users/ajcolubiale/projects/cheddar-logic/WORK_QUEUE/WI-0656.md

<interfaces>
<!-- Key types the executor must build against. -->

From cheddar-fpl-sage/backend/models/draft_api_models.py:
```python
class PlayerEntry(BaseModel):
    fpl_player_id: int
    player_name: str
    position: Literal["GKP", "DEF", "MID", "FWD"]
    team_short: str
    price: float
    ownership_pct: float          # 0–100
    form: float
    is_locked: bool
    is_differential: bool

class DraftBuild(BaseModel):
    build_type: Literal["primary", "contrast"]
    players: List[PlayerEntry]    # 15 players (11 starters + 4 bench)
    total_value: float
    formation: str                # e.g. "4-4-2"
    strategy_label: str
    rationale: str
    constraints_applied: List[str]
    squad_meta: Dict[str, Any]

class DraftSessionResponse(BaseModel):
    session_id: str
    manager_id: str
    gameweek: int
    status: Literal["open", "completed", "abandoned"]
    constraints: DraftConstraints
    started_at: str
    completed_at: Optional[str]
```

From cheddar-fpl-sage/backend/models/profile_api_models.py:
```python
ManagerArchetype = Literal[
    "Safe Template",
    "Balanced Climber",
    "Aggressive Hunter",
    "Value/Flex Builder",
    "Set-and-Hold",
]
```

Router registration pattern (from backend/routers/__init__.py + main.py):
```python
# __init__.py — add to imports and __all__
from .draft_analysis import router as draft_analysis_router

# main.py — add after existing include_router calls
app.include_router(draft_analysis_router, prefix=settings.API_V1_PREFIX)
```
</interfaces>
</context>

<tasks>

<task type="auto" tdd="true">
  <name>Task 1: Draft analysis models + audit + compare services</name>
  <files>
    cheddar-fpl-sage/backend/models/draft_analysis_api_models.py
    cheddar-fpl-sage/backend/services/draft_audit.py
    cheddar-fpl-sage/backend/services/draft_compare.py
    cheddar-fpl-sage/tests/test_draft_audit.py
    cheddar-fpl-sage/tests/test_draft_compare.py
  </files>
  <behavior>
    Models (draft_analysis_api_models.py):
    - AuditRequest: session_id: str, archetype: ManagerArchetype (optional, defaults to "Safe Template")
    - AuditDimension: name: str, score: float (0.0–1.0), label: Literal["strong","ok","weak"], commentary: str
    - AuditResponse: session_id, archetype, dimensions: List[AuditDimension] (exactly 8), overall_verdict: str, what_breaks_this: List[str]
    - The 8 dimensions are: "structure", "philosophy_fit", "captaincy_strength", "template_exposure", "fragility", "correlation_exposure", "exit_liquidity", "time_to_fix"
    - CompareRequest: session_id_a: str, session_id_b: str (compare by session refs); OR squad_a: DraftBuild, squad_b: DraftBuild (compare by inline squads); archetype: Optional[ManagerArchetype]
    - CompareWinner: Literal["a", "b", "tie"]
    - CompareDelta: dimension: str, winner: CompareWinner, margin: str, explanation: str
    - CompareResponse: winner: CompareWinner, winner_rationale: str, deltas: List[CompareDelta], archetype_fit_note: str

    Audit service (draft_audit.py) — score_audit(build: DraftBuild, archetype: str) -> AuditResponse:
    - structure: proportion of starters fully covered by valid formation; score = 1.0 if valid 15-slot squad, penalise position imbalance
    - philosophy_fit: how well the build aligns to archetype. Aggressive Hunter rewards differentials + high ceil; Safe Template rewards high ownership + template overlap
    - captaincy_strength: score based on top-3 players by form*price; high form premium players raise score
    - template_exposure: fraction of starters with ownership_pct > 20; high for Safe Template is good, penalised for Aggressive Hunter
    - fragility: fraction of starters flagged as differential or low-form (< 4.0 form) — high = risky
    - correlation_exposure: max club representation in starters / 11; > 3 same-club starters increases score (risk)
    - exit_liquidity: fraction of players with price < 6.0 (hard to sell); lower is better for flex
    - time_to_fix: heuristic based on how many players are locked + banned count from constraints_applied; fewer locked = easier to pivot
    - All scores are floats in [0.0, 1.0]. Label thresholds: score >= 0.65 -> "strong", >= 0.35 -> "ok", else "weak"
    - Archetype modulates commentary text only (same numeric logic, different language)
    - what_breaks_this: 2-4 strings drawn from highest-risk dimensions

    Compare service (draft_compare.py) — compare_drafts(build_a: DraftBuild, build_b: DraftBuild, archetype: str) -> CompareResponse:
    - Score both builds on all 8 dimensions via draft_audit.score_audit()
    - For each dimension, winner = "a" if score_a > score_b+0.05 else "b" if score_b > score_a+0.05 else "tie"
    - Overall winner = archetype-weighted vote: Safe Template/Set-and-Hold weight structure+fragility+template_exposure; Aggressive Hunter/Value weights captaincy_strength+exit_liquidity+philosophy_fit; ties broken by sum
    - winner_rationale: 1–2 sentence summary naming the deciding dimensions
    - archetype_fit_note: explains how archetype preference influenced the outcome

    Test coverage (15+ tests total across both files):
    - test_structure_score_valid_squad: full 15-player squad returns structure >= 0.9
    - test_philosophy_fit_aggressive_rewards_differentials: build with 3+ differentials scores higher under "Aggressive Hunter" than "Safe Template"
    - test_fragility_high_with_low_form: build with 8 players below form 4.0 scores fragility >= 0.7 (risky label "weak")
    - test_correlation_exposure_3_same_club: 3 same-club starters increases correlation_exposure score
    - test_audit_returns_8_dimensions: always returns exactly 8 AuditDimension entries
    - test_compare_winner_determined: when build_a has clearly better overall scores, winner == "a"
    - test_compare_tie_within_margin: builds that differ by < 0.05 on all dimensions return winner == "tie"
    - test_compare_archetype_shifts_winner: same two builds swap winner when archetype changes from "Safe Template" to "Aggressive Hunter"
    - test_what_breaks_this_nonempty: audit always returns 2–4 what_breaks_this strings
  </behavior>
  <action>
    Create draft_analysis_api_models.py with Pydantic models as described in behavior. No imports from draft_api_models needed in models file — accept DraftBuild as-is for the compare inline path.

    Create draft_audit.py with score_audit(build: DraftBuild, archetype: str) -> AuditResponse. Scoring is pure Python arithmetic on the PlayerEntry list — no external calls, no randomness. All dimension scores must be deterministic for the same input.

    Create draft_compare.py with compare_drafts(build_a, build_b, archetype) -> CompareResponse. Import score_audit from draft_audit. Archetype weighting uses a dict lookup, not if-else chains — keeps it extensible.

    Write tests first (RED), then implement services (GREEN). Use synthetic PlayerEntry fixtures to isolate scoring logic.
  </action>
  <verify>
    <automated>cd /Users/ajcolubiale/projects/cheddar-logic && python -m pytest cheddar-fpl-sage/tests/test_draft_audit.py cheddar-fpl-sage/tests/test_draft_compare.py -x -q 2>&1 | tail -20</automated>
  </verify>
  <done>All tests pass. score_audit returns exactly 8 named dimensions. compare_drafts winner shifts between archetypes for appropriate test builds.</done>
</task>

<task type="auto" tdd="true">
  <name>Task 2: Draft analysis router + main.py registration + API tests</name>
  <files>
    cheddar-fpl-sage/backend/routers/draft_analysis.py
    cheddar-fpl-sage/backend/routers/__init__.py
    cheddar-fpl-sage/backend/main.py
    cheddar-fpl-sage/tests/test_draft_analysis_api.py
  </files>
  <behavior>
    Router (draft_analysis.py):
    - APIRouter(prefix="/draft-sessions", tags=["draft-analysis"])
    - POST /{session_id}/audit: load session via draft_service.get_session(), raise 404 if missing, extract build from session (use session.constraints and a synthetic stub build from draft_builder if no generate has been called yet — or accept an optional inline DraftBuild in the request body), call score_audit(build, archetype), return AuditResponse
    - POST /compare: accept CompareRequest body; if session refs provided, load both sessions and use their generated builds; if inline squads provided, use them directly; call compare_drafts(); return CompareResponse; raise 404 if a referenced session is missing; raise 422 if neither session refs nor inline squads provided
    - Note: audit endpoint path /{session_id}/audit must not conflict with draft_sessions router's /{session_id} path — use a different router prefix or ensure FastAPI route ordering is correct. Use prefix="/draft-sessions" and the audit route as "/{session_id}/audit" — FastAPI will match the more-specific path first.

    AuditRequest body must include optional archetype field. If omitted, default to "Safe Template".
    CompareRequest can supply either (session_id_a + session_id_b) OR (squad_a + squad_b) — use pydantic model_validator to enforce at least one pair is present.

    Registration:
    - Add draft_analysis_router to backend/routers/__init__.py imports and __all__
    - Add app.include_router(draft_analysis_router, prefix=settings.API_V1_PREFIX) to main.py after the draft_sessions_router line

    API tests (test_draft_analysis_api.py) using FastAPI TestClient — 10+ tests:
    - test_audit_returns_200_with_valid_session: create a session, call audit, get 200 with 8 dimensions
    - test_audit_404_unknown_session: POST /draft-sessions/bad-id/audit returns 404
    - test_audit_inline_build: POST with inline DraftBuild in body returns 200
    - test_compare_by_sessions: create two sessions, call /compare with session_id_a and session_id_b, get 200 with winner field
    - test_compare_inline_squads: POST with squad_a + squad_b inline returns 200 CompareResponse
    - test_compare_404_missing_session_a: missing session_id_a returns 404
    - test_compare_422_no_squads_or_sessions: empty body returns 422
    - test_audit_archetype_aware: same session audited as "Aggressive Hunter" vs "Safe Template" returns different commentary on philosophy_fit
    - test_compare_returns_tradeoff_deltas: response.deltas is non-empty list
    - test_compare_winner_rationale_nonempty: winner_rationale is a non-empty string
  </behavior>
  <action>
    Create draft_analysis.py router. Import AuditRequest, AuditResponse, CompareRequest, CompareResponse from draft_analysis_api_models. Import score_audit from draft_audit, compare_drafts from draft_compare, draft_service from draft_service.

    For the audit endpoint: sessions from WI-0654 store constraints but not a generated build snapshot. To avoid requiring a prior /generate call, accept an optional inline_build: Optional[DraftBuild] in the AuditRequest. If provided, use it. If not, construct a minimal synthetic DraftBuild using the session's constraints metadata with empty players list — but since score_audit needs players, raise 422 with message "Provide inline_build or call /generate first" when no build is available.

    For the compare endpoint: use pydantic @model_validator(mode="after") to enforce that either both session IDs or both inline squads are provided, but not a mix of one session and one inline squad (raise 422 for mixed input).

    Update __init__.py: add import and __all__ entry for draft_analysis_router.
    Update main.py: add include_router call after the existing draft_sessions_router line. Follow the existing pattern exactly.

    Write API tests using TestClient(app) from fastapi.testclient. Reuse the synthetic PlayerEntry builder fixture from test_draft_audit.py as a conftest helper or inline helper.
  </action>
  <verify>
    <automated>cd /Users/ajcolubiale/projects/cheddar-logic && python -m pytest cheddar-fpl-sage/tests/test_draft_analysis_api.py -x -q 2>&1 | tail -20</automated>
  </verify>
  <done>All API tests pass. POST /draft-sessions/{id}/audit and POST /draft-sessions/compare are reachable and return correct response shapes. Router is registered in main.py. Full test suite still passes: pytest cheddar-fpl-sage/tests/ -q --tb=no exits 0.</done>
</task>

</tasks>

<verification>
Run full test suite after both tasks:

```bash
cd /Users/ajcolubiale/projects/cheddar-logic && python -m pytest cheddar-fpl-sage/tests/test_draft_audit.py cheddar-fpl-sage/tests/test_draft_compare.py cheddar-fpl-sage/tests/test_draft_analysis_api.py -v 2>&1 | tail -30
```

Also confirm no regressions:
```bash
cd /Users/ajcolubiale/projects/cheddar-logic && python -m pytest cheddar-fpl-sage/tests/ -q --tb=short 2>&1 | tail -20
```
</verification>

<success_criteria>
- `pytest cheddar-fpl-sage/tests/test_draft_audit.py` — all tests pass
- `pytest cheddar-fpl-sage/tests/test_draft_compare.py` — all tests pass
- `pytest cheddar-fpl-sage/tests/test_draft_analysis_api.py` — all tests pass
- POST /api/v1/draft-sessions/{id}/audit returns AuditResponse with exactly 8 AuditDimension entries
- POST /api/v1/draft-sessions/compare returns CompareResponse with winner + non-empty deltas + winner_rationale
- Audit is profile-aware: same build audited under "Aggressive Hunter" vs "Safe Template" produces different philosophy_fit commentary
- Full test suite passes with no regressions
- WORK_QUEUE/WI-0656.md CLAIM field updated to completed with timestamp
</success_criteria>

<output>
After completion, create `.planning/quick/112-wi-0656/112-SUMMARY.md` documenting:
- Files created/modified
- Test count and pass rate
- Endpoint paths registered
- Key scoring design decisions (dimension formulas, archetype weighting strategy)
- Any deviations from the plan
</output>
