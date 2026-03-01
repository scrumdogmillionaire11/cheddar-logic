# FPL Sage - Milestone 1 Roadmap

**Milestone:** MVP Web Application Launch
**Target:** GW25 (February 2026)
**Status:** In Progress

---

## Phase Overview

| Phase | Name | Goal | Status |
|-------|------|------|--------|
| 1 | CLI Stabilization | Fix critical tech debt before web wrap | Complete (2026-01-24) |
| 2 | Backend API | FastAPI wrapper for decision engine | Complete (2026-01-29) |
| 3 | Frontend Core | React dashboard with analysis flow | Complete (2026-01-30) |
| 4 | Auth & Limits | Usage limits (2/GW) by Team ID, no payments | Complete (2026-01-30) |
| 5 | Launch Prep | Production deployment, monitoring, legal | Not Started |

---

## Phase 1: CLI Stabilization

**Goal:** Address critical tech debt in existing CLI before wrapping in web API. Ensure the engine is reliable, testable, and has clear contracts.

**Why First:** The web app is only as good as the underlying engine. Current issues (bare exceptions, config fragility, untested edge cases) would propagate to web users.

**Plans:** 5 plans in 3 waves

Plans:
- [x] 01-01-PLAN.md - Foundation: exceptions, models, constants
- [x] 01-02-PLAN.md - Module extraction from 3,681-line monolith
- [x] 01-03-PLAN.md - Pydantic config validation
- [x] 01-04-PLAN.md - Replace bare exception handlers
- [x] 01-05-PLAN.md - Bug fixes (manual player, chip window) + tests

### Key Deliverables
- [x] Break up `enhanced_decision_framework.py` (3,681 -> 2,197 lines, 41% reduction)
- [x] Replace bare `except Exception:` with specific error handling (27 fixed)
- [x] Add schema validation for config serialization
- [x] Add tests for manual player fallback, chip window failures (35 new tests)
- [x] Fix known bugs: manual player display name, chip window graceful fallback

### Success Criteria
- All tests pass with no bare exception warnings
- Config round-trips cleanly (write -> read -> same data)
- Manual players display correctly
- Chip window analysis produces results (not "UNAVAILABLE")

### Dependencies
- None (can start immediately)

### Estimated Scope
- 5-8 files modified
- ~15-20 test cases added

---

## Phase 2: Backend API

**Goal:** Create FastAPI backend that exposes decision engine as HTTP endpoints with proper error handling, rate limiting, and async support. Also fix critical bug where manual transfers are not applied before generating recommendations.

**Why:** Web frontend needs REST/WebSocket endpoints to trigger analysis and stream progress.

**Plans:** 5 plans in 4 waves

Plans:
- [x] 02-01-PLAN.md - FastAPI project structure + manual transfers bug fix
- [x] 02-02-PLAN.md - Core endpoints (POST /analyze, GET /analyze/{id})
- [x] 02-03-PLAN.md - WebSocket real-time progress streaming
- [x] 02-04-PLAN.md - Rate limiting + response caching (Redis)
- [x] 02-05-PLAN.md - Error contracts + integration tests

### Key Deliverables
- [x] FastAPI project structure (`/backend` in monorepo)
- [x] `/api/v1/analyze` endpoint - trigger full analysis
- [x] `/api/v1/analyze/{id}` - poll analysis status
- [x] WebSocket endpoint for real-time progress
- [x] Error response contracts (validation, rate limit, API failures)
- [x] Rate limiting (Redis-based, 100 req/hr per user)
- [x] Response caching for same-GW repeated analysis
- [x] Fix: Manual transfers applied before recommendations

### Key Endpoints
```
POST /api/v1/analyze
  Body: { team_id: int, gameweek?: int }
  Response: { analysis_id: string, status: "queued" }

GET /api/v1/analyze/{id}
  Response: { status, progress?, results? }

WS /api/v1/analyze/{id}/stream
  Messages: { type, progress, phase, results? }
```

### Success Criteria
- Analysis completes in <10 seconds
- Progress updates every 1-2 seconds via WebSocket
- Proper error responses for invalid team_id, rate limits, API failures
- Manual transfers are applied before generating recommendations
- 50+ API tests pass

### Dependencies
- Phase 1 (stable engine with clear contracts)

### Estimated Scope
- New `/backend` directory
- ~10-15 API routes
- Redis for caching/rate limiting

---

## Phase 3: Frontend Core

**Goal:** React frontend with mobile-first design implementing the clinical "decision console" aesthetic. Core analysis flow: enter team -> run analysis -> view recommendations.

**Why:** The visible product users interact with. Design differentiation is key competitive advantage.

### Key Deliverables
- [x] React + TypeScript + Vite project setup
- [x] Tailwind + shadcn/ui component library
- [x] Team ID entry screen (6-step flow with validation)
- [x] Analysis progress screen (WebSocket real-time updates)
- [x] Results dashboard:
  - Transfer recommendations with reasoning
  - Captain pick with pool comparison
  - Chip timing optimization
  - Optimized XI display
- [x] Mobile-responsive layouts (320px -> 1920px)
- [x] Dark mode default (clinical aesthetic)
- [x] Injury override selector (bonus feature)

### Key Screens
1. **Landing/Team Entry** - FPL Team ID input, quick profiles
2. **Analysis Progress** - Progress bar, phase updates, estimated time
3. **Results Dashboard** - Tabbed view: Transfers | Captain | Chips | XI
4. **Reasoning Drawer** - Expandable "why" sections for each recommendation

### Success Criteria
- Lighthouse score 90+ (performance, accessibility)
- Works on iOS Safari 14+, Chrome Android
- <2 second initial load
- Touch-friendly (44px minimum tap targets)

### Dependencies
- Phase 2 (API endpoints to call)

### Estimated Scope
- New `/frontend` directory
- ~15-20 React components
- ~5-8 pages/screens

---

## Phase 4: Auth & Limits

**Goal:** Implement usage tracking and enforcement for freemium model. Track analyses per FPL Team ID, enforce 2 analyses per gameweek, show usage counter and clear limit messaging.

**Why:** Enable freemium business model. No accounts or payments yet (deferred to post-MVP) - just usage limits by team_id.

**Plans:** 2 plans in 2 waves

Plans:
- [x] 04-01-PLAN.md — Backend usage tracking service + enforcement + API
- [x] 04-02-PLAN.md — Frontend usage display + limit reached UI

### Key Deliverables
- [x] Usage tracking service (Redis-based, per team_id per gameweek)
- [x] Analyze endpoint enforces 2 analyses/GW limit
- [x] GET /api/v1/usage/{team_id} endpoint
- [x] UsageCounter component (displays "X of 2 analyses used this GW")
- [x] LimitReached component (countdown + cached results access)
- [x] Gameweek reset detection (via FPL API)
- [x] Graceful degradation (allow if Redis unavailable)

### Success Criteria
- Usage limits enforced correctly (1st OK, 2nd OK, 3rd blocked)
- Usage counter displays on landing page
- Blocked users see clear messaging with countdown to reset
- Blocked users can access cached results
- Different team_ids have independent quotas
- Resets automatically when new gameweek starts

### Dependencies
- Phase 3 (frontend screens to add usage UI)
- Phase 2 (backend API to add usage tracking)

### Estimated Scope
- Backend: 1 service, 1 router, middleware updates
- Frontend: 2 components, Landing/Results page updates

### Deferred to Post-MVP
- Stripe payment integration
- Email accounts and signup
- Paid tier with unlimited analyses
- Multi-device session handling

---

## Phase 5: Launch Prep

**Goal:** Production deployment, monitoring, legal compliance, and go-live readiness (no PWA).

**Why:** Professional launch requires working infrastructure, operational visibility, and legal protection.

**Plans:** 4 plans in 2 waves

Plans:
- [ ] 05-01-PLAN.md — Production build configuration (Vercel + Railway)
- [ ] 05-02-PLAN.md — Legal documents (Terms of Service + Privacy Policy)
- [ ] 05-03-PLAN.md — Deploy to production (Vercel + Railway + DNS)
- [ ] 05-04-PLAN.md — Monitoring & analytics (Sentry + Plausible + Discord)

### Key Deliverables
- [ ] Production deployment:
  - Frontend to Vercel with `/fpl-sage` base path
  - Backend to Railway with Redis plugin
  - DNS routing via Cloudflare (cheddarlogic.com/fpl-sage)
- [ ] Monitoring setup:
  - Sentry for error tracking (frontend + backend)
  - Discord webhooks for critical alerts
  - Plausible or Umami for privacy-friendly analytics
- [ ] Legal compliance:
  - Terms of Service (usage limits, liability, data handling)
  - Privacy Policy (GDPR-inspired, minimal data collection)
  - Legal pages accessible via /terms and /privacy routes

### Success Criteria
- Frontend accessible at cheddarlogic.com/fpl-sage
- Backend API responding to requests from frontend
- Error tracking captures frontend and backend crashes
- Analytics tracking page views (cookieless)
- Discord alerts fire on critical errors
- Legal pages published and accessible
- End-to-end flow works in production

### Dependencies
- Phases 2-4 complete

### Estimated Scope
- 4 deployment configs
- 2 legal documents
- 3 monitoring integrations

### Deferred (User Decision)
- PWA features (no offline mode, no install prompts)
- Uptime monitoring (can add post-launch)
- Load testing (defer until traffic warrants)
- Marketing content (Reddit/Twitter posts)

---

## Gap Analysis: Current State vs MVP

### Working Well (Keep)
- Data pipeline (collect -> normalize -> validate)
- Injury resolution with source hierarchy
- Captain selection logic
- Transfer recommendation engine
- Output serialization to structured reports

### Needs Improvement (Phase 1)
- Large monolithic decision framework file
- Bare exception handling throughout
- Config serialization fragility
- Missing test coverage for edge cases
- Known bugs (manual player display, chip window)

### Missing Entirely (Phases 2-5)
- HTTP API layer
- Web frontend
- User authentication
- Payment processing
- Production infrastructure
- PWA capabilities

### Technical Debt Priority

| Issue | Severity | Phase to Address |
|-------|----------|------------------|
| Bare exceptions (25+ instances) | High | Phase 1 |
| Config serialization fragility | High | Phase 1 |
| 3,681-line monolith file | Medium | Phase 1 |
| No network failure tests | Medium | Phase 1 |
| Manual player display bug | Low | Phase 1 |
| Chip window "missing context" | Low | Phase 1 |
| Manual transfers not applied | High | Phase 2 |
| No API response caching | Medium | Phase 2 |
| No rate limiting | Medium | Phase 2 |

---

## Timeline Estimate

**Note:** Not predictions, just rough sequencing.

- **Phase 1:** First - stabilize foundation
- **Phase 2:** After Phase 1 - API layer
- **Phase 3:** Parallel with Phase 2 end - frontend
- **Phase 4:** After Phase 3 - monetization
- **Phase 5:** Final - launch prep

**Critical Path:** Phase 1 -> Phase 2 -> Phase 3 -> Phase 4 -> Phase 5

---

*Roadmap created: 2026-01-23*
*Phase 1 planned: 2026-01-23*
*Phase 2 planned: 2026-01-28*
*Phase 4 planned: 2026-01-30*
*Phase 5 planned: 2026-01-30*
