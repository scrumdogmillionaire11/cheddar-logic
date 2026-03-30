---
phase: quick
plan: 107-wi-0655-screenshot-parsing-and-parsed-sq
type: execute
wave: 1
depends_on: []
files_modified:
  - cheddar-fpl-sage/backend/models/screenshot_api_models.py
  - cheddar-fpl-sage/backend/services/player_registry.py
  - cheddar-fpl-sage/backend/services/screenshot_parser.py
  - cheddar-fpl-sage/backend/routers/screenshot_parse.py
  - cheddar-fpl-sage/backend/routers/__init__.py
  - cheddar-fpl-sage/backend/main.py
  - cheddar-fpl-sage/tests/test_player_registry.py
  - cheddar-fpl-sage/tests/test_screenshot_parser.py
  - cheddar-fpl-sage/tests/fixtures/screenshots/.gitkeep
autonomous: true
requirements: [WI-0655]

must_haves:
  truths:
    - "POST /api/v1/screenshot-parse accepts 1-3 base64-encoded FPL mobile screenshots and returns a parsed-squad response"
    - "Parser classifies layout as pitch_view or list_view and extracts up to 15 player slots"
    - "Each slot carries a confidence score; ambiguous slots expose candidates instead of a forced single assignment"
    - "Response includes starters (11), bench (4), captain, vice_captain, and unresolved_slots list"
    - "Low-confidence slots (confidence < threshold) never silently appear as resolved"
    - "PlayerRegistry fuzzy-matches player names against current FPL bootstrap data"
  artifacts:
    - path: "cheddar-fpl-sage/backend/models/screenshot_api_models.py"
      provides: "Pydantic request/response models for screenshot parse endpoint"
      exports: [ScreenshotParseRequest, ParsedSlot, ParsedSquad, ScreenshotParseResponse]
    - path: "cheddar-fpl-sage/backend/services/player_registry.py"
      provides: "In-memory player registry with fuzzy name matching"
      exports: [PlayerRegistry, player_registry]
    - path: "cheddar-fpl-sage/backend/services/screenshot_parser.py"
      provides: "Layout classification and slot extraction pipeline"
      exports: [ScreenshotParser, screenshot_parser]
    - path: "cheddar-fpl-sage/backend/routers/screenshot_parse.py"
      provides: "FastAPI router POST /screenshot-parse"
      exports: [router]
    - path: "cheddar-fpl-sage/tests/test_player_registry.py"
      provides: "Unit tests for registry lookup and fuzzy match"
    - path: "cheddar-fpl-sage/tests/test_screenshot_parser.py"
      provides: "Unit tests for layout classification, slot extraction, confidence scoring"
  key_links:
    - from: "routers/screenshot_parse.py"
      to: "services/screenshot_parser.py"
      via: "screenshot_parser.parse(images)"
    - from: "services/screenshot_parser.py"
      to: "services/player_registry.py"
      via: "player_registry.match(name) -> (player_id, confidence, candidates)"
    - from: "routers/screenshot_parse.py"
      to: "main.py"
      via: "app.include_router(screenshot_parse_router, prefix=settings.API_V1_PREFIX)"
---

<objective>
Build the MVP screenshot parsing pipeline for official FPL mobile screenshots and normalize the result into a 15-man parsed squad with slot-level confidence scoring.

Purpose: Lets the FPL Sage product accept a screenshot of a user's team and produce a structured squad object that downstream features (draft comparison, audit scoring) can consume without manual data entry.
Output: POST /api/v1/screenshot-parse endpoint, player registry service, parser service, and full test coverage.
</objective>

<execution_context>
@/Users/ajcolubiale/.claude/get-shit-done/workflows/execute-plan.md
@/Users/ajcolubiale/.claude/get-shit-done/templates/summary.md
</execution_context>

<context>
@cheddar-fpl-sage/backend/main.py
@cheddar-fpl-sage/backend/config.py
@cheddar-fpl-sage/backend/routers/__init__.py
@cheddar-fpl-sage/backend/models/api_models.py
@cheddar-fpl-sage/tests/conftest.py

<interfaces>
<!-- Key patterns from existing codebase. Executor should use these directly. -->

Router pattern (from user.py):
```python
router = APIRouter(prefix="/user", tags=["user"])
```

Router wiring in main.py:
```python
app.include_router(user_router, prefix=settings.API_V1_PREFIX)
# -> registered at /api/v1/user/...
```

Router export in routers/__init__.py:
```python
from .user import router as user_router
__all__ = ["advisor_router", "analyze_router", "user_router"]
```

Test pattern (conftest.py):
```python
@pytest.fixture
def client() -> TestClient:
    with TestClient(app) as test_client:
        yield test_client
```

Test pattern (service unit tests — instantiate fresh per test):
```python
class TestMyService:
    def setup_method(self):
        self.service = MyService()  # fresh instance, no singleton pollution
```
</interfaces>
</context>

<tasks>

<task type="auto" tdd="true">
  <name>Task 1: Models + PlayerRegistry service</name>
  <files>
    cheddar-fpl-sage/backend/models/screenshot_api_models.py,
    cheddar-fpl-sage/backend/services/player_registry.py,
    cheddar-fpl-sage/tests/test_player_registry.py
  </files>
  <behavior>
    - PlayerRegistry.match(raw_name: str) -> MatchResult where MatchResult has (player_id, display_name, confidence: float 0-1, candidates: list[CandidateMatch])
    - Exact match returns confidence=1.0, empty candidates list
    - Fuzzy match (difflib.SequenceMatcher ratio >= 0.8) returns confidence=ratio, candidates=[top-3 matches]
    - No match (ratio < 0.5) returns confidence=0.0, player_id=None, candidates=[]
    - PlayerRegistry loads from a static in-memory dict of {player_id: display_name} keyed by FPL player ID; bootstrap data injected at construction for testability
    - Test: exact match "Salah" -> confidence 1.0, known player_id
    - Test: fuzzy match "Salaah" -> confidence >= 0.8, candidates non-empty, Salah in top candidate
    - Test: garbage input "XXXXXX" -> confidence 0.0, player_id None
    - Test: registry loads all provided players at construction
  </behavior>
  <action>
    1. Create `cheddar-fpl-sage/backend/models/screenshot_api_models.py` with these Pydantic models:
       - `CandidateMatch(player_id: int, display_name: str, confidence: float)`
       - `ParsedSlot(slot_index: int, position: Literal["GKP","DEF","MID","FWD","BENCH"], player_id: Optional[int], display_name: Optional[str], confidence: float, candidates: list[CandidateMatch], is_captain: bool = False, is_vice_captain: bool = False)`
       - `ParsedSquad(starters: list[ParsedSlot], bench: list[ParsedSlot], captain: Optional[ParsedSlot], vice_captain: Optional[ParsedSlot], unresolved_slots: list[ParsedSlot])`
       - `ScreenshotParseRequest(images: list[str] = Field(..., min_length=1, max_length=3, description="Base64-encoded PNG/JPEG screenshots"))`
       - `ScreenshotParseResponse(squad: ParsedSquad, layout_detected: Literal["pitch_view","list_view","unknown"], images_processed: int, parse_warnings: list[str])`

    2. Create `cheddar-fpl-sage/backend/services/player_registry.py`:
       - `CandidateMatch` dataclass (or reuse Pydantic from models — import from screenshot_api_models)
       - `PlayerRegistry` class: `__init__(self, players: dict[int, str])` — accepts {player_id: display_name}
       - `match(self, raw_name: str) -> MatchResult` using difflib.SequenceMatcher; return top-3 fuzzy candidates when confidence < 1.0
       - CONFIDENCE_THRESHOLD_HIGH = 0.95 (resolved), CONFIDENCE_THRESHOLD_LOW = 0.5 (unresolved below this)
       - Module-level `player_registry` singleton initialized with a small hardcoded sample dict (enough for tests); production init can be replaced by a bootstrap loader later
       - Do NOT call external FPL API in MVP — static in-memory data only per WI-0655 scope

    3. Write `cheddar-fpl-sage/tests/test_player_registry.py` covering all behavior cases above. Use fresh `PlayerRegistry(players={...})` per test, not the module singleton.
  </action>
  <verify>
    <automated>cd /Users/ajcolubiale/projects/cheddar-logic/cheddar-fpl-sage && python -m pytest tests/test_player_registry.py -v 2>&1 | tail -20</automated>
  </verify>
  <done>All PlayerRegistry tests pass. Models importable. Exact/fuzzy/no-match cases verified.</done>
</task>

<task type="auto" tdd="true">
  <name>Task 2: ScreenshotParser service + endpoint + wiring</name>
  <files>
    cheddar-fpl-sage/backend/services/screenshot_parser.py,
    cheddar-fpl-sage/backend/routers/screenshot_parse.py,
    cheddar-fpl-sage/backend/routers/__init__.py,
    cheddar-fpl-sage/backend/main.py,
    cheddar-fpl-sage/tests/test_screenshot_parser.py,
    cheddar-fpl-sage/tests/fixtures/screenshots/.gitkeep
  </files>
  <behavior>
    - ScreenshotParser.detect_layout(image_bytes: bytes) -> Literal["pitch_view","list_view","unknown"]
      - pitch_view detection: image aspect ratio portrait (height > width * 1.2) AND presence of a grid-like region
      - list_view detection: image aspect ratio roughly square or landscape AND row-dominant structure
      - MVP heuristic only — no ML; return "unknown" when neither heuristic fires
    - ScreenshotParser.extract_slots(image_bytes: bytes, layout: str) -> list[dict] where each dict has {"raw_name": str, "position": str, "slot_index": int, "is_captain": bool, "is_vice_captain": bool}
      - MVP: return synthetic deterministic extraction based on image dimensions for testability (production OCR wiring is a future WI)
      - For unknown layout: return empty list with a parse warning
    - ScreenshotParser.parse(images: list[bytes]) -> tuple[ParsedSquad, str, list[str]]
      - Iterates images, detects layout per image, merges extracted slots across images (deduplicated by slot_index)
      - Calls player_registry.match() for each raw_name to resolve player_id and confidence
      - Slots with confidence < CONFIDENCE_THRESHOLD_LOW go to unresolved_slots; never appear in starters/bench as resolved
      - Assigns captain/vice_captain fields from slot flags
      - Returns (squad, detected_layout, warnings)
    - Test: parse([single_portrait_image_bytes]) -> squad with starters list, bench list, layout "pitch_view"
    - Test: parse([]) raises ValueError("at least one image required")
    - Test: slots with confidence < 0.5 appear in unresolved_slots, NOT in starters
    - Test: captain slot sets squad.captain field
    - POST /api/v1/screenshot-parse returns 422 if images list is empty
    - POST /api/v1/screenshot-parse returns 200 with ScreenshotParseResponse shape for valid base64 input
  </behavior>
  <action>
    1. Create `cheddar-fpl-sage/tests/fixtures/screenshots/.gitkeep` (empty, just ensures directory exists for golden fixture storage).

    2. Create `cheddar-fpl-sage/backend/services/screenshot_parser.py`:
       - Import PIL (Pillow) only if available, guard with try/except; fall back to reading image dimensions via struct if Pillow not installed — check requirements.txt first (`grep Pillow cheddar-fpl-sage/backend/requirements.txt`).
       - `detect_layout(image_bytes: bytes) -> Literal["pitch_view","list_view","unknown"]` — use PIL Image.open(BytesIO(image_bytes)) to get width/height. pitch_view if height > width * 1.2, list_view if width >= height * 0.9, else "unknown".
       - `extract_slots(image_bytes: bytes, layout: str) -> list[dict]` — MVP synthetic: return a hardcoded 15-slot scaffold using image size as seed for position labels. This makes the pipeline testable without real OCR. Include comments: "OCR wiring is a future WI — this is the synthetic MVP scaffold."
       - `parse(images: list[bytes]) -> tuple[ParsedSquad, str, list[str]]` — full pipeline using player_registry singleton for matching.
       - Module-level `screenshot_parser = ScreenshotParser()` singleton.

    3. Create `cheddar-fpl-sage/backend/routers/screenshot_parse.py`:
       ```python
       from fastapi import APIRouter
       from backend.models.screenshot_api_models import ScreenshotParseRequest, ScreenshotParseResponse
       from backend.services.screenshot_parser import screenshot_parser
       import base64

       router = APIRouter(prefix="/screenshot-parse", tags=["screenshot-parse"])

       @router.post("", response_model=ScreenshotParseResponse)
       async def parse_screenshot(request: ScreenshotParseRequest) -> ScreenshotParseResponse:
           image_bytes_list = [base64.b64decode(img) for img in request.images]
           squad, layout, warnings = screenshot_parser.parse(image_bytes_list)
           return ScreenshotParseResponse(
               squad=squad,
               layout_detected=layout,
               images_processed=len(image_bytes_list),
               parse_warnings=warnings,
           )
       ```

    4. Update `cheddar-fpl-sage/backend/routers/__init__.py` — add:
       ```python
       from .screenshot_parse import router as screenshot_parse_router
       __all__ = [..., "screenshot_parse_router"]
       ```

    5. Update `cheddar-fpl-sage/backend/main.py` — add after the existing user_router include:
       ```python
       from backend.routers import screenshot_parse_router
       app.include_router(screenshot_parse_router, prefix=settings.API_V1_PREFIX)
       ```

    6. Write `cheddar-fpl-sage/tests/test_screenshot_parser.py` covering all behavior cases above. Synthesize minimal valid PNG bytes using `io.BytesIO` + PIL or a raw 1x1 PNG bytestring for layout detection tests. Use the `client` fixture from conftest.py for endpoint tests, POSTing a base64-encoded minimal image.
  </action>
  <verify>
    <automated>cd /Users/ajcolubiale/projects/cheddar-logic/cheddar-fpl-sage && python -m pytest tests/test_player_registry.py tests/test_screenshot_parser.py -v 2>&1 | tail -30</automated>
  </verify>
  <done>
    All parser and endpoint tests pass. POST /api/v1/screenshot-parse reachable. Unresolved slots surfaced for low-confidence. No silent complete-parse on ambiguous input.
  </done>
</task>

</tasks>

<verification>
Full test suite:
```
cd /Users/ajcolubiale/projects/cheddar-logic/cheddar-fpl-sage && python -m pytest tests/test_player_registry.py tests/test_screenshot_parser.py -v
```

Endpoint smoke test:
```bash
# Generate minimal 1x1 base64 PNG and POST to endpoint
python -c "
import base64, io
from PIL import Image
buf = io.BytesIO()
Image.new('RGB', (100, 150), color=(255,255,255)).save(buf, format='PNG')
print(base64.b64encode(buf.getvalue()).decode())
" | xargs -I{} curl -s -X POST http://localhost:8000/api/v1/screenshot-parse \
  -H 'Content-Type: application/json' \
  -d "{\"images\": [\"{}\"]}" | python -m json.tool
```
</verification>

<success_criteria>
- `pytest tests/test_player_registry.py tests/test_screenshot_parser.py` passes with >= 20 tests covering exact match, fuzzy match, no-match, multi-image merge, low-confidence unresolved slot surfacing, captain assignment, and endpoint shape validation.
- POST /api/v1/screenshot-parse returns 200 with a ScreenshotParseResponse containing starters, bench, unresolved_slots, and parse_warnings.
- Low-confidence player slots (confidence < 0.5) appear in unresolved_slots, never silently in starters or bench.
- No OCR-only exact-name matching as sole recovery path (fuzzy matching via player_registry is the fallback per WI-0655 guard).
- MVP restricted to official FPL mobile screenshots (pitch_view / list_view detection) per WI-0655 out-of-scope constraints.
</success_criteria>

<output>
After completion, create `.planning/quick/107-wi-0655-screenshot-parsing-and-parsed-sq/107-SUMMARY.md` using the summary template.
</output>
