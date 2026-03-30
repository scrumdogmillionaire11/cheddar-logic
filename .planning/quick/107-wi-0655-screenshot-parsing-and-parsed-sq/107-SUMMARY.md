---
phase: quick
plan: 107-wi-0655-screenshot-parsing-and-parsed-sq
subsystem: fpl-sage-backend
tags: [screenshot-parsing, player-registry, fuzzy-matching, fastapi, fpl-sage]
dependency_graph:
  requires: [WI-0652]
  provides: [screenshot-parse-endpoint, player-registry, parsed-squad-contract]
  affects: [WI-0656]
tech_stack:
  added: [Pillow (image layout detection), difflib.SequenceMatcher (fuzzy match)]
  patterns: [TDD, synthetic-MVP-scaffold, slot-level-confidence-routing]
key_files:
  created:
    - cheddar-fpl-sage/backend/models/screenshot_api_models.py
    - cheddar-fpl-sage/backend/services/player_registry.py
    - cheddar-fpl-sage/backend/services/screenshot_parser.py
    - cheddar-fpl-sage/backend/routers/screenshot_parse.py
    - cheddar-fpl-sage/tests/test_player_registry.py
    - cheddar-fpl-sage/tests/test_screenshot_parser.py
    - cheddar-fpl-sage/tests/fixtures/screenshots/.gitkeep
  modified:
    - cheddar-fpl-sage/backend/routers/__init__.py
    - cheddar-fpl-sage/backend/main.py
decisions:
  - "Synthetic MVP scaffold for extract_slots instead of real OCR — OCR wiring deferred to future WI per WI-0655 scope"
  - "Token-level fuzzy matching (max score over full name + individual tokens) to handle surname-only OCR inputs"
  - "player_registry expanded to 19 hardcoded players to cover all synthetic scaffold names without external API"
metrics:
  duration: "4 minutes"
  completed: "2026-03-30"
  tasks_completed: 2
  files_created: 7
  files_modified: 2
  tests_added: 51
---

# Quick Task 107: WI-0655 Screenshot Parsing + Parsed-Squad Normalization Summary

**One-liner:** MVP screenshot parsing pipeline — aspect-ratio layout detection, 15-slot synthetic extraction, difflib fuzzy player matching, and confidence-gated squad normalization via POST /api/v1/screenshot-parse.

## Objective

Build the MVP screenshot parsing pipeline for official FPL mobile screenshots and normalize the result into a 15-man parsed squad with slot-level confidence scoring. Enables downstream features (draft comparison, audit scoring) to consume a user's team without manual data entry.

## What Was Built

### Task 1: Models + PlayerRegistry

- **`backend/models/screenshot_api_models.py`** — Pydantic models: `CandidateMatch`, `ParsedSlot`, `ParsedSquad`, `ScreenshotParseRequest` (1-3 images), `ScreenshotParseResponse`
- **`backend/services/player_registry.py`** — `PlayerRegistry` class using `difflib.SequenceMatcher` with token-level matching so surname-only inputs (e.g., "Salaah") resolve correctly. Thresholds: `CONFIDENCE_THRESHOLD_HIGH=0.95`, `CONFIDENCE_THRESHOLD_LOW=0.5`. Module-level `player_registry` singleton with 19 hardcoded FPL players.
- **19 unit tests** covering exact match, fuzzy match, no-match, empty registry, and construction.

### Task 2: ScreenshotParser + Endpoint

- **`backend/services/screenshot_parser.py`** — Three methods:
  - `detect_layout(image_bytes)`: Pillow aspect-ratio heuristic — pitch_view if `height > width * 1.2`, list_view if `width >= height * 0.9`, unknown otherwise
  - `extract_slots(image_bytes, layout)`: Synthetic deterministic 15-slot scaffold (OCR wiring is a future WI per scope)
  - `parse(images)`: Full pipeline — detects layout per image, merges slots by `slot_index` (dedup), resolves player names via registry, routes low-confidence slots (`< 0.5`) to `unresolved_slots`, assigns `captain` / `vice_captain`
- **`backend/routers/screenshot_parse.py`** — `POST /screenshot-parse` router decoding base64 images and delegating to `screenshot_parser.parse()`
- Wired into `routers/__init__.py` and `main.py` under `/api/v1` prefix
- **32 new tests** covering layout detection, slot extraction, full parse pipeline, and endpoint integration (422 on empty/oversized payloads, 200 shape validation)

## Success Criteria Status

| Criterion | Status |
|---|---|
| `pytest tests/test_player_registry.py tests/test_screenshot_parser.py` passes with >= 20 tests | PASS — 51 tests |
| POST /api/v1/screenshot-parse returns 200 with ScreenshotParseResponse (starters, bench, unresolved_slots, parse_warnings) | PASS |
| Low-confidence slots (< 0.5) in unresolved_slots, never silently in starters/bench | PASS |
| Fuzzy matching via player_registry as fallback (no OCR-only exact-name sole path) | PASS |
| MVP restricted to pitch_view / list_view detection per WI-0655 out-of-scope constraints | PASS |

## Decisions Made

1. **Synthetic MVP scaffold for OCR** — `extract_slots` returns a hardcoded 15-slot list per WI-0655 scope. Real OCR wiring is explicitly deferred to a future WI. Comments in source mark the extension point.
2. **Token-level fuzzy matching** — `SequenceMatcher` scores against full display name AND each name token (first, last, etc.), taking the max. This ensures surname-only OCR outputs like "Salaah" → "Mohamed Salah" achieve confidence ≥ 0.8.
3. **Registry expanded to 19 players** — Added all players referenced by the synthetic scaffold so the full 15-slot parse pipeline exercises non-trivial matching, not just 6 players.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Token-level matching needed for surname-only inputs**
- **Found during:** Task 1 GREEN phase
- **Issue:** `SequenceMatcher` against full names like "Mohamed Salah" gave confidence ~0.53 for "Salaah" — below the 0.8 fuzzy threshold the tests expected
- **Fix:** Added token-level scoring loop: `max(ratio_against_full_name, max(ratios_against_tokens))`. Short names now correctly resolve to confidence >= 0.8
- **Files modified:** `backend/services/player_registry.py`
- **Commit:** 6ce7f62

**2. [Rule 1 - Bug] Registry sample too small for full pipeline test**
- **Found during:** Task 2 GREEN phase (parse starters/bench count assertions)
- **Issue:** 9 of the 15 synthetic scaffold player names were not in the 10-player registry → fell to unresolved_slots → starters count was 6, not 11
- **Fix:** Expanded `_SAMPLE_PLAYERS` to 19 entries covering all synthetic scaffold names
- **Files modified:** `backend/services/player_registry.py`
- **Commit:** 8d91364

## Commits

| Hash | Message |
|---|---|
| 6ce7f62 | feat(107-wi-0655): add screenshot API models and PlayerRegistry service |
| 8d91364 | feat(107-wi-0655): add ScreenshotParser service, endpoint, and wiring |

## Self-Check: PASSED

All 7 created files confirmed present. Both commits (6ce7f62, 8d91364) confirmed in git log.
