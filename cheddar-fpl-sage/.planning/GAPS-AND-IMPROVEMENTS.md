# FPL Sage - Gaps & Improvement Analysis

**Analysis Date:** 2026-01-23
**Purpose:** Synthesize current state gaps and improvement opportunities for MVP launch

---

## Executive Summary

The CLI engine works and produces valuable recommendations. However, significant gaps exist between current state and a production-ready web application:

1. **Code Quality Gaps** - Tech debt that would propagate to web users
2. **Missing Layers** - No API, no frontend, no auth/payments
3. **Production Gaps** - No monitoring, deployment, or legal compliance
4. **Test Coverage Gaps** - Edge cases untested, could cause production failures

---

## 1. Code Quality Gaps

### Critical: Error Handling

**Issue:** 25+ instances of bare `except Exception:` throughout codebase

**Files Affected:**
- [data_gate.py](src/cheddar_fpl_sage/validation/data_gate.py) (2 instances)
- [fpl_sage_integration.py](src/cheddar_fpl_sage/analysis/fpl_sage_integration.py) (22+ instances)
- [enhanced_decision_framework.py](src/cheddar_fpl_sage/analysis/enhanced_decision_framework.py) (4 instances)
- [sprint3_5_config_manager.py](src/cheddar_fpl_sage/utils/sprint3_5_config_manager.py) (3 instances)

**Impact:**
- Hides root causes of failures
- Network timeouts, JSON parse failures silently swallowed
- Users see generic errors, can't troubleshoot
- Debugging production issues nearly impossible

**Improvement:**
```python
# Before (bad)
try:
    data = fetch_api()
except Exception:
    logger.error("Failed")
    return None

# After (good)
try:
    data = fetch_api()
except aiohttp.ClientError as e:
    logger.error(f"Network error fetching API: {e}")
    raise DataCollectionError("FPL API unreachable") from e
except json.JSONDecodeError as e:
    logger.error(f"Invalid JSON from API: {e}")
    raise DataCollectionError("FPL API returned invalid data") from e
```

**Priority:** High (Phase 1)

---

### High: Monolithic Decision Framework

**Issue:** `enhanced_decision_framework.py` is 3,681 lines

**Problems:**
- Touches too many concerns (XI optimization, risk assessment, chip timing, captaincy)
- Difficult to test individual components
- Changes risk unintended side effects
- Hard to onboard new developers

**Improvement:** Break into focused modules:
```
src/cheddar_fpl_sage/analysis/
├── decision_framework/
│   ├── __init__.py           # Public API
│   ├── xi_optimizer.py       # Formation optimization
│   ├── risk_assessor.py      # Risk scenario analysis
│   ├── chip_engine.py        # Chip timing decisions
│   ├── captaincy_advisor.py  # Captain selection
│   └── transfer_advisor.py   # Transfer recommendations
```

**Priority:** Medium (Phase 1)

---

### High: Config Serialization Fragility

**Issue:** Manual overrides can be stored as stringified JSON or dict; multiple normalization functions try to handle this inconsistently

**Files Affected:**
- [fpl_sage_integration.py:63-100](src/cheddar_fpl_sage/analysis/fpl_sage_integration.py)
- [sprint3_5_config_manager.py:30-52](src/cheddar_fpl_sage/utils/sprint3_5_config_manager.py)

**Impact:**
- Config written but not read correctly
- Silent data loss
- Users report "my overrides don't work"

**Improvement:**
1. Define strict JSON schema for `team_config.json`
2. Validate on write (reject malformed)
3. Validate on read (fail fast with clear error)
4. Add schema version for future migrations

```python
CONFIG_SCHEMA = {
    "team_id": int,
    "manual_chips": {"bench_boost": bool, "triple_captain": bool, ...},
    "injury_overrides": {str: {"status": str, "chance": int}},
    ...
}

def write_config(config: dict) -> None:
    validate_schema(config, CONFIG_SCHEMA)  # Raises on invalid
    atomic_write("team_config.json", config)
```

**Priority:** High (Phase 1)

---

### Medium: Hardcoded Magic Numbers

**Issue:** Player ID `999999` used as sentinel for manually added players

**Impact:**
- Manual players display as "Player 999999 - £0.0m"
- Fragile to changes
- No clear documentation

**Improvement:**
```python
# Create explicit model
@dataclass
class ManualPlayer:
    name: str
    position: str
    team: str
    estimated_points: float = 5.0

    @property
    def display_name(self) -> str:
        return f"{self.name} ({self.team}, {self.position})"
```

**Priority:** Low (Phase 1)

---

## 2. Missing Layers

### Backend API (Phase 2)

**Current:** No HTTP API - CLI only

**Required:**
- FastAPI wrapper for decision engine
- REST endpoints for analysis, status, results
- WebSocket for real-time progress
- Rate limiting (prevent abuse)
- Response caching (same-GW efficiency)

**Key Endpoints Needed:**
```
POST /api/v1/analyze         # Start analysis
GET  /api/v1/analyze/{id}    # Poll results
WS   /api/v1/analyze/{id}/stream  # Real-time progress
GET  /api/v1/health          # Health check
```

---

### Frontend (Phase 3)

**Current:** No web UI

**Required:**
- React + TypeScript application
- Mobile-first responsive design
- Clinical "decision console" aesthetic
- Team entry → Progress → Results flow

**Key Screens:**
1. Landing / Team ID Entry
2. Analysis Progress (real-time)
3. Results Dashboard (transfers, captain, chips, XI)
4. Reasoning panels (expandable "why")

---

### Auth & Payments (Phase 4)

**Current:** No user management or monetization

**Required:**
- User session management
- Usage tracking (analyses per GW)
- Freemium gate (2 free/GW)
- Stripe integration
- Subscription management

---

## 3. Production Gaps

### Infrastructure

**Missing:**
- Production deployment pipeline
- Database provisioning (PostgreSQL)
- Redis for caching/rate limiting
- CDN configuration
- SSL/TLS setup

### Monitoring

**Missing:**
- Error tracking (Sentry)
- Uptime monitoring (Uptime Robot)
- Analytics (Plausible)
- Log aggregation
- Alerting

### Legal Compliance

**Missing:**
- Terms of Service
- Privacy Policy (GDPR)
- Cookie consent banner
- Consumer rights compliance (14-day refunds)

---

## 4. Test Coverage Gaps

### High Priority (Should Block Deployment)

| Gap | Risk | Files |
|-----|------|-------|
| No tests for manual player fallback | Known bug undetected | enhanced_decision_framework.py |
| No tests for config edge cases | Config corruption | sprint3_5_config_manager.py |
| No tests for network failures | Unknown production behavior | collectors/*.py |

### Medium Priority

| Gap | Risk | Files |
|-----|------|-------|
| No tests for chip window failures | "Missing context" bug | enhanced_decision_framework.py |
| No tests for invalid squad states | Bad recommendations | manual_transfer_manager.py |
| No tests for malformed injury data | Silent FIT marking | injury/processing.py |

---

## 5. Improvement Opportunities

### Quick Wins (Low Effort, High Impact)

1. **Add specific exception types** - 2-3 hours per file, huge debugging improvement
2. **Schema validation on config** - 1-2 hours, prevents user-reported bugs
3. **Fix manual player display** - 30 minutes, cosmetic but noticeable

### Strategic Improvements (Higher Effort, Foundational)

1. **Break up decision framework** - 1-2 days, enables parallel development
2. **Add response caching** - 4-6 hours, reduces API load 80%
3. **Implement retry logic** - 2-3 hours, handles network flakiness

### Performance Improvements

1. **Cache projections by gameweek** - Same-GW analyses reuse work
2. **Stream large file processing** - Future-proofs for data growth
3. **Session pooling** - Reduces connection overhead

---

## 6. Recommended Execution Order

### Phase 1: CLI Stabilization (Do First)

1. Replace bare exceptions with specific handlers
2. Add schema validation for config
3. Add tests for critical edge cases
4. Fix known bugs (manual player, chip window)
5. Consider breaking up monolith (optional for MVP)

### Phase 2: Backend API

1. FastAPI project setup
2. Core analysis endpoint
3. WebSocket progress streaming
4. Rate limiting
5. Response caching

### Phase 3: Frontend

1. React project setup
2. Team entry screen
3. Progress screen
4. Results dashboard
5. Mobile optimization

### Phase 4: Auth & Payments

1. Session management
2. Usage tracking
3. Stripe integration
4. Freemium gate

### Phase 5: Launch Prep

1. Production deployment
2. Monitoring setup
3. Legal compliance
4. Load testing

---

## Summary

**What's Working:**
- Core decision engine produces valuable recommendations
- Data pipeline is solid (collect → normalize → validate)
- Injury resolution handles multiple sources correctly
- Output serialization produces structured reports

**What Needs Work:**
- Error handling is too broad (hides issues)
- Config handling is fragile (user-facing bugs)
- Test coverage has critical gaps
- No web layer exists yet

**Biggest Risks:**
1. February deadline (14 GWs at stake)
2. Unknown production behavior (untested edge cases)
3. FPL API changes (external dependency)

**Recommended Focus:**
Start with Phase 1 (CLI Stabilization) to build on a solid foundation. The web app is only as good as the engine powering it.

---

*Analysis completed: 2026-01-23*
