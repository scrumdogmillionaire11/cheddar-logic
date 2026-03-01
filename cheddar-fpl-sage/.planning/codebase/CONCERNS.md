# Codebase Concerns

**Analysis Date:** 2026-01-23

## Tech Debt

**Enhanced Decision Framework Complexity:**
- Issue: `src/cheddar_fpl_sage/analysis/enhanced_decision_framework.py` is 3,681 lines, making it difficult to maintain and test
- Files: `src/cheddar_fpl_sage/analysis/enhanced_decision_framework.py`
- Impact: Large monolithic file is fragile and hard to refactor; touches too many concerns (XI optimization, risk assessment, chip timing, captaincy logic)
- Fix approach: Break into smaller modules: `xi_optimizer.py`, `risk_assessor.py`, `chip_decision_engine.py`, `captaincy_advisor.py`

**Hardcoded Magic Numbers in Decision Logic:**
- Issue: Player ID `999999` used as sentinel for manually added players, conservative point estimates hardcoded in fallback projections
- Files: `src/cheddar_fpl_sage/analysis/enhanced_decision_framework.py` (lines 219, 496); `src/cheddar_fpl_sage/analysis/enhanced_decision_framework.py` (lines 228-237)
- Impact: Fragile to changes; manual players get conservative estimates (Collins shows as "Player 999999 - £0.0m"); difficult to adjust fallback scoring
- Fix approach: Create `ManualPlayerProjection` dataclass with configurable defaults; use symbolic constant or enum for manual player marker

**Bare Exception Handlers Throughout Codebase:**
- Issue: Over 25 instances of `except Exception:` with no specific error type catching across analysis, validation, and utility modules
- Files: `src/cheddar_fpl_sage/validation/data_gate.py` (lines 34, 112); `src/cheddar_fpl_sage/analysis/fpl_sage_integration.py` (22+ instances); `src/cheddar_fpl_sage/analysis/enhanced_decision_framework.py` (4 instances); `src/cheddar_fpl_sage/utils/sprint3_5_config_manager.py` (3 instances)
- Impact: Hides errors; swallows critical failures; logging doesn't always happen; difficult to debug; masked network timeouts, JSON parse failures
- Fix approach: Replace with specific exception types (JSONDecodeError, FileNotFoundError, aiohttp.ClientError); log with context; re-raise or handle intentionally

**Config Serialization/Deserialization Issues:**
- Issue: Manual chip status, injury overrides, and transfer configs can be stored as stringified JSON or dict; multiple normalization functions try to handle this
- Files: `src/cheddar_fpl_sage/analysis/fpl_sage_integration.py` (lines 63-100); `src/cheddar_fpl_sage/utils/sprint3_5_config_manager.py` (lines 30-52, 102-120)
- Impact: Schema is poorly defined; config loading is brittle; users report config written but not read (addressed partially in Sprint 3.5); potential for silent data loss
- Fix approach: Enforce strict schema in `Sprint35ConfigManager`; validate on write; reject malformed input; add schema versioning with migration path

**Manual Transfer Manager State Tracking:**
- Issue: Manual transfers tracked separately from FPL API state; no atomic updates; no validation that transfers fit squad rules
- Files: `src/cheddar_fpl_sage/utils/manual_transfer_manager.py`
- Impact: Can result in invalid squad state (e.g., too many forwards); no rollback mechanism if transfer validation fails; user must re-enter if analysis fails
- Fix approach: Make transfer manager track pre/post squad state; validate against FPL rules before persisting; provide rollback/undo mechanism

**Hard-coded Output Paths:**
- Issue: Output directory structure hardcoded in multiple places; no centralized path configuration
- Files: `src/cheddar_fpl_sage/analysis/fpl_sage_integration.py` (lines 177, 183, 1161-1163); `src/cheddar_fpl_sage/injury/processing.py` (line 22); `src/cheddar_fpl_sage/utils/output_manager.py` (line 67)
- Impact: Can't easily change output location; scripts may fail if directories don't exist; tests create side effects in real output dirs
- Fix approach: Create `OutputConfig` dataclass; pass through dependency injection; centralize in environment or config file

## Known Bugs

**Manual Player Display Name Fallback:**
- Symptoms: Manually added players (like Collins) display as "Player 999999 - £0.0m - 5.0 pts" instead of actual name
- Files: `src/cheddar_fpl_sage/analysis/enhanced_decision_framework.py` (lines 219-240)
- Trigger: When adding a player manually without full FPL API data; fallback projection uses temporary ID
- Workaround: User must recognize the ID; cosmetic issue doesn't affect analysis correctness
- Root cause: Display formatting logic doesn't handle manual players with fallback projections

**Chip Window Analysis Missing Context:**
- Symptoms: "🧭 Chip Window: UNAVAILABLE (missing context)" appears in output headers
- Files: `src/cheddar_fpl_sage/analysis/enhanced_decision_framework.py` (likely in chip decision context building)
- Trigger: Chip window scoring logic fails to compute; missing required gameweek/fixture data
- Workaround: Recommendations proceed without chip timing optimization
- Root cause: Chip window analysis requires future fixture data; calculation incomplete or skipped

**Questionable Defensive Recommendations:**
- Symptoms: System recommends 2 Brentford defenders (Thiago FWD + Lewis-Potter DEF) against Chelsea in same gameweek
- Files: `src/cheddar_fpl_sage/analysis/enhanced_decision_framework.py` (XI selection logic, likely lines 264-285)
- Trigger: Fixture difficulty scoring or positional classification incorrect
- Workaround: User can manually override in config
- Root cause: Likely positional classification error or fixture difficulty calculation bug; defender scoring for attacking defenders not penalized enough

## Security Considerations

**Manual Overrides via Config File:**
- Risk: Config file contains manual injury overrides, manual transfers, and override status; file permissions not enforced
- Files: `team_config.json` (user-provided); `src/cheddar_fpl_sage/utils/sprint3_5_config_manager.py`
- Current mitigation: File is read/written locally only; no network exposure
- Recommendations: Validate config on load; warn if file permissions are world-readable; consider encrypting sensitive fields

**Async Session Management:**
- Risk: aiohttp ClientSession created in collectors; if exceptions occur before proper cleanup, sessions may leak
- Files: `src/cheddar_fpl_sage/collectors/enhanced_fpl_collector.py`; `src/cheddar_fpl_sage/collectors/weekly_snapshot_collector.py`
- Current mitigation: `__aenter__` and `__aexit__` context managers used; some catch-all exception handlers
- Recommendations: Ensure all async paths go through context managers; add explicit session.close() in exception handlers

**No Input Validation on Team ID:**
- Risk: Team IDs passed without validation; could cause spurious API requests or incorrect data collection
- Files: `src/cheddar_fpl_sage/analysis/fpl_sage_integration.py` (lines 49-51); `fpl_sage.py` (main entry point)
- Current mitigation: FPL API returns 404 for invalid teams
- Recommendations: Validate team_id is numeric and in reasonable range (1-10000); fail early with clear message

## Performance Bottlenecks

**Enhanced Decision Framework XI Optimization Greedy Algorithm:**
- Problem: Loops through 4 GK combinations and then greedy-selects remaining players; O(n²) in worst case for XI feasibility checking
- Files: `src/cheddar_fpl_sage/analysis/enhanced_decision_framework.py` (lines 268-285+)
- Cause: No constraint programming or branch-and-bound; tries each GK then greedy-fills remaining slots
- Improvement path: Implement proper combinatorial optimizer (even simple backtracking would be faster); cache formation feasibility checks

**Large Files Processing Without Streaming:**
- Problem: Bootstrap static, events, and fixtures loaded entirely into memory; no streaming/pagination
- Files: `src/cheddar_fpl_sage/collectors/enhanced_fpl_collector.py`; `src/cheddar_fpl_sage/collectors/weekly_snapshot_collector.py`
- Cause: Assumes FPL dataset is small enough to fit in memory (it is, ~50MB), but future-proofing needed
- Improvement path: Implement generator-based processing for large data; consider incremental parsing for fixtures/events

**Config Reload Every Analysis Run:**
- Problem: `Sprint35ConfigManager.get_config(force_reload=True)` called in `FPLSageIntegration.__init__`, reads file from disk every run
- Files: `src/cheddar_fpl_sage/analysis/fpl_sage_integration.py` (line 46)
- Cause: Cache invalidation to ensure fresh reads, but no batching
- Improvement path: Keep cache warm until user explicitly requests reload; use file modification timestamp to detect changes

**No Projection Caching:**
- Problem: Projections computed fresh for every analysis run; no cache of previous results
- Files: `src/cheddar_fpl_sage/analysis/enhanced_decision_framework.py` (entire XI optimization section)
- Cause: Projections tied to current gameweek; reuse difficult without versioning
- Improvement path: Cache projections by gameweek; invalidate only on new data collection

## Fragile Areas

**Weekly Snapshot Collector Timeout Handling:**
- Files: `src/cheddar_fpl_sage/collectors/weekly_snapshot_collector.py`
- Why fragile: Bare `except Exception:` catches timeouts and returns generic error; no retry logic; network flakiness causes analysis to fail completely
- Safe modification: Add specific handling for aiohttp.ClientError and TimeoutError; implement exponential backoff retry; log full traceback
- Test coverage: No test for timeout scenarios; smoke tests pass but real network failures untested

**Data Gate Freshness Validation:**
- Files: `src/cheddar_fpl_sage/validation/data_gate.py` (lines 31-37)
- Why fragile: `_age_minutes()` silently returns 1e9 on timestamp parse failure; no warning to user if freshness check uses fallback
- Safe modification: Log warning when timestamp parsing fails; validate timestamp format upfront; fail explicitly rather than silent fallback
- Test coverage: Test passes for valid timestamps; no test for malformed timestamps

**Manual Transfer Validation Against Squad Rules:**
- Files: `src/cheddar_fpl_sage/utils/manual_transfer_manager.py`; transfer logic in `fpl_sage_integration.py`
- Why fragile: No validation that manual transfers maintain 3-5-2 formation, position limits, or team limits; user can create invalid squads
- Safe modification: Add `SquadValidator` that checks formation, position counts, team counts before accepting transfer; provide clear error messages
- Test coverage: Transfer manager has no unit tests; integration tests may not cover invalid squad states

**Enhanced Decision Framework Dependency on Field Names:**
- Files: `src/cheddar_fpl_sage/analysis/enhanced_decision_framework.py` (heavy use of `player.get()`, 398+ instances)
- Why fragile: Uses dict.get() for all field access; silently defaults to None/empty; no schema validation; changes to collector output break silently
- Safe modification: Define SquadPlayer and ProjectionPlayer dataclasses; validate input schema; raise on missing required fields
- Test coverage: Tests mock player data; if collector changes field names, tests won't catch it

**Injury Report Resolution Logic:**
- Files: `src/cheddar_fpl_sage/injury/processing.py` (lines 100-106)
- Why fragile: Multiple `except Exception:` blocks in `resolve_injury_payloads()`; if injury resolution fails partially, some players marked as FIT by accident
- Safe modification: Validate injury payloads schema upfront; return partial results with error list; log which players failed to resolve
- Test coverage: `test_injury_pipeline.py` has 80 lines but no test for malformed injury reports

## Scaling Limits

**Single-User Configuration Model:**
- Current capacity: 1 team per analysis run; one `team_config.json` file
- Limit: Can't easily support multiple concurrent analyses or team management
- Scaling path: Migrate to multi-tenant config (keyed by team_id); support multiple profiles; add config versioning for rollback

**Async Session Per Collector Instance:**
- Current capacity: 1 aiohttp session per EnhancedFPLCollector instance
- Limit: Creating many collectors in parallel creates many sessions; FPL API may rate-limit
- Scaling path: Implement session pool; add rate limiter (backoff-based); batch requests

**No API Response Caching:**
- Current capacity: Each analysis re-fetches bootstrap, fixtures, events, team data
- Limit: Multiple analyses per gameweek hit FPL API multiple times; no deduplication
- Scaling path: Implement response cache with gameweek versioning; share cache across multiple analysis runs in same gameweek

## Dependencies at Risk

**aiohttp ClientSession Not Properly Closed in All Paths:**
- Risk: If exception occurs before `async with` cleanup, session may leak
- Impact: Long-running services could exhaust file descriptors
- Migration plan: Audit all async context managers; add try/finally wrappers; consider moving to httpx with sync fallback

**No Lock/Mutex on Shared Config File:**
- Risk: If two analyses run simultaneously, both may read/write `team_config.json` causing race condition
- Impact: Config corruption; manual overrides lost; analysis produces incorrect results
- Migration plan: Add file-level locking using `fcntl` (Unix) or `msvcrt` (Windows); use atomic file writes; add config versioning

**Legacy Namespace Still Present:**
- Risk: Tests check for absence of legacy namespaces; but old code paths may still exist
- Impact: Dead code not detected; confusion about what's actually used
- Migration plan: Remove legacy test; audit imports to confirm all old modules deleted

## Test Coverage Gaps

**No Tests for Manual Player Fallback:**
- What's not tested: Manually added players (player_id 999999) with fallback projections; display name formatting for manual players
- Files: `src/cheddar_fpl_sage/analysis/enhanced_decision_framework.py` (lines 219-240)
- Risk: Known bug (display name showing as "Player 999999") remains undetected; future changes could make it worse
- Priority: High

**No Tests for Config Serialization Edge Cases:**
- What's not tested: Stringified JSON in config fields; malformed JSON; missing required fields; config corruption recovery
- Files: `src/cheddar_fpl_sage/utils/sprint3_5_config_manager.py`; `src/cheddar_fpl_sage/analysis/fpl_sage_integration.py`
- Risk: Users report config written but not read; silent failures when parsing fails; no detection of corrupted config files
- Priority: High

**No Tests for Chip Window Analysis Failure:**
- What's not tested: Chip window scoring when fixture data incomplete; missing gameweek context; failure modes of chip decision logic
- Files: `src/cheddar_fpl_sage/analysis/enhanced_decision_framework.py` (chip decision methods)
- Risk: Known bug ("missing context" message) not caught by tests; regression undetected
- Priority: Medium

**No Tests for Invalid Squad States:**
- What's not tested: Manual transfers creating invalid formations (e.g., 6 forwards); too many players from same team; position violations
- Files: `src/cheddar_fpl_sage/utils/manual_transfer_manager.py`
- Risk: User can create invalid squads; analysis produces bad recommendations; FPL API would reject submission
- Priority: High

**No Tests for Network Failure Scenarios:**
- What's not tested: aiohttp timeouts, SSL errors, HTTP 429/503 responses, partial connection failures
- Files: `src/cheddar_fpl_sage/collectors/weekly_snapshot_collector.py`; `src/cheddar_fpl_sage/collectors/enhanced_fpl_collector.py`
- Risk: Unknown behavior on network issues; users don't know if retry is happening; no backoff implemented
- Priority: Medium

**No Tests for Injury Report Malformed Data:**
- What's not tested: Missing fields in injury payloads, incorrect status values, timestamp parsing failures
- Files: `src/cheddar_fpl_sage/injury/processing.py`
- Risk: Partial injury resolution could mark all players as FIT incorrectly; users make decisions on incomplete injury info
- Priority: Medium

**Legacy Test Skipped:**
- What's not tested: Legacy collector functionality (simple_fpl_collector); test explicitly skipped module-level
- Files: `tests/test_collection.py`
- Risk: If legacy code is ever needed, no test coverage exists
- Priority: Low (low risk since legacy is deprecated)

---

*Concerns audit: 2026-01-23*
