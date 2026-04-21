**1. Executive Summary**
Current state: production behavior is heavily feature-flag dependent, and the default posture currently favors accessibility over enforcement. The biggest risks are auth boundary bypass-by-config, brittle security control wiring, and very large request handlers that are hard to reason about under failure.

Top 5 risks:
1. Premium/admin-ish surfaces are effectively public unless route-handler.ts are explicitly enabled in every environment.
2. IP-based controls depend on untrusted header extraction in rate-limiter.ts, making allowlist controls weaker than they appear.
3. Query-validation allowlist drift causes functional breakage in routes that require query params (notably route.ts).
4. Large hot-path handlers ([games route handler](web/src/lib/games/route-handler.ts), results API) increase regression and latency risk.
5. Tests often validate source text, not behavior (example: api-admin-model-health.test.js).

Top 5 waste areas:
1. Duplicate cards logic across cards route and cards by game route.
2. Duplicated security-header definitions in middleware.ts and security-headers.ts.
3. Unused header helper security-headers.ts.
4. Large source-contract tests that can pass while runtime behavior fails.
5. Multiple feature-flag branches around auth create permanent complexity tax.

Top 5 highest-leverage fixes:
1. Make auth wall fail-closed for protected endpoints/pages.
2. Replace IP trust model with proxy-aware trusted client IP derivation.
3. Fix query validation registry drift and add automated route-to-validation contract tests.
4. Split monolithic route handlers into query/service/transform modules.
5. Replace source-string tests with request-level integration tests.

---

**2. Findings By Severity**

**Critical**

[Auth Is Opt-In, Not Enforced-By-Default]  
Category: Security  
Severity: Critical  
Confidence: Confirmed  
Location: route-handler.ts, route.ts, [web/src/app/api/cards/[gameId]/route.ts#L313](web/src/app/api/cards/[gameId]/route.ts#L313), page.tsx, page.tsx  
Problem:
- Entitlement checks run only when ENABLE_AUTH_WALLS is exactly true.
- Pages and routes include explicit commented auth bypass notes.  
Why it matters:
- Misconfig or omission exposes paid/premium surfaces without authentication.
- Blast radius includes user entitlement model and paid content gates.  
Evidence:
- Conditional guards wrap auth in the listed files.
- Wedge/FPL pages explicitly show disabled auth blocks.  
Fix:
- Invert to fail-closed policy for protected resources.
- Require explicit ALLOW_PUBLIC=true per route/page that is intentionally public.
- Add startup hard-fail if protected routes are live while auth wall is disabled.  
Priority: Now

**High**

[IP Allowlist And Rate Limits Trust Spoofable Headers]  
Category: Security  
Severity: High  
Confidence: Likely  
Location: rate-limiter.ts, route.ts  
Problem:
- Client IP is taken from forwarded headers without trusted-proxy verification.
- Token route allowlist enforcement depends on this client IP path.  
Why it matters:
- Attackers can shape headers in some deployments and evade throttles/allowlists.
- If token route is enabled outside dev with allowlist, this can open token minting.  
Evidence:
- Header candidates are consumed directly; no trust boundary check.
- Token route checks allowed IP set using getClientIp.  
Fix:
- Use platform-provided trusted IP only (or parse X-Forwarded-For from trusted reverse proxy chain).
- Reject forwarded headers unless request source is trusted edge/proxy.
- Add signed internal header from edge layer for client IP.  
Priority: Now

[Query Validation Registry Drift Breaks Real Endpoints]  
Category: Stability  
Severity: High  
Confidence: Confirmed  
Location: validation.ts, route.ts, route.ts, route.ts  
Problem:
- performSecurityChecks validates query params against a hardcoded endpoint map.
- /api/performance and /api/model-outputs are not present in ALLOWED_QUERY_PARAMS.  
Why it matters:
- /api/performance requires query params, so validation can reject valid calls as Unknown API endpoint.
- Causes silent production breakage after adding new endpoints/params.  
Evidence:
- Missing map keys in validation file.
- Route behavior depends on query params post-security-check.  
Fix:
- Generate allowlist from endpoint schemas (single source of truth).
- Add CI test: every route using performSecurityChecks must be present in validator registry with declared params.
- Return route-specific validation errors, not unknown endpoint.  
Priority: Now

[Source-String Tests Provide False Confidence]  
Category: Testing  
Severity: High  
Confidence: Confirmed  
Location: api-admin-model-health.test.js, ui-results-smoke.test.js, api-potd.test.js  
Problem:
- Many tests assert routeSource.includes(...) instead of invoking handlers and asserting behavior.  
Why it matters:
- Refactors that preserve strings can pass while behavior regresses.
- These tests are brittle to formatting and weak against runtime bugs.  
Evidence:
- Tests read files and assert string tokens.  
Fix:
- Replace high-value source-contract tests with request-level integration tests using seeded DB fixtures.
- Keep only minimal static-contract tests where runtime assertion is impossible.  
Priority: Next

[Internal Error Details Returned To Clients]  
Category: Security  
Severity: High  
Confidence: Confirmed  
Location: route.ts, [web/src/app/api/cards/[gameId]/route.ts#L473](web/src/app/api/cards/[gameId]/route.ts#L473), route.ts, route.ts  
Problem:
- Error responses propagate raw error strings/messages.  
Why it matters:
- Can leak SQL/schema/runtime internals, aiding exploit path discovery and incident probing.
- Increases attack reconnaissance surface.  
Evidence:
- Response payloads include String(err) or message from caught exception.  
Fix:
- Return opaque error IDs to clients.
- Log structured internal details server-side only.  
Priority: Next

**Medium**

[Monolithic Hot Paths Increase Latency And Regression Risk]  
Category: Performance  
Severity: Medium  
Confidence: Confirmed  
Location: route-handler.ts, route.ts  
Problem:
- Very large handlers with many DB calls, transformation layers, and fallback branches.
- games handler is 4267 lines; results handler 1380 lines.  
Why it matters:
- Hard to optimize and reason about partial failures.
- Increased chance of introducing regressions when changing one concern.  
Evidence:
- File sizes and dense sequential query/transform logic.  
Fix:
- Split into query services, domain mappers, and response assemblers.
- Add perf budgets per stage with per-query timing export.  
Priority: Next

[Server And Shared Modules Duplicate Security Header Logic]  
Category: Waste  
Severity: Medium  
Confidence: Confirmed  
Location: middleware.ts, security-headers.ts, security-headers.ts  
Problem:
- Two independent header definitions; helper appears unused.  
Why it matters:
- Drift risk and duplicated maintenance.
- Security policy changes can be partial/inconsistent.  
Evidence:
- createSecurityHeaders has no call sites.
- middleware inlines a separate header set.  
Fix:
- Centralize header config for edge/runtime compatibility with one authoritative source.
- Remove unused helper or wire it into middleware generation path.  
Priority: Next

[Local In-Memory Rate Limiter Is Not Multi-Instance Safe]  
Category: Operations  
Severity: Medium  
Confidence: Confirmed  
Location: rate-limiter.ts  
Problem:
- Limiter state is process-local map.
- Fallback identifier can collapse to unknown:user-agent.  
Why it matters:
- Horizontal scaling weakens effective limits.
- In missing-IP-header scenarios, legitimate users can throttle each other.  
Evidence:
- In-code comment recommends Redis for production.
- Unknown IP fallback derived from user agent string.  
Fix:
- Move to distributed limiter store (Redis/upstash).
- Separate global and per-identity limits; do not key fallback solely on user-agent.  
Priority: Next

[Rate-Limit Header Handling Is Inconsistent Across Routes/Paths]  
Category: Operations  
Severity: Medium  
Confidence: Confirmed  
Location: [web/src/app/api/cards/[gameId]/route.ts#L457](web/src/app/api/cards/[gameId]/route.ts#L457), route.ts  
Problem:
- Some success/error paths do not call addRateLimitHeaders.  
Why it matters:
- Clients lose predictable retry/backoff signals.
- Harder to debug throttling and tune client behavior.  
Evidence:
- cards/[gameId] returns plain NextResponse.json in terminal paths.
- /api/performance catch returns plain response.  
Fix:
- Wrap all exit paths with a shared response finalizer that always applies security and rate-limit headers.  
Priority: Later

[Moderate Vulnerable Transitive Dependency Detected]  
Category: Dependency  
Severity: Medium  
Confidence: Confirmed  
Location: root/worker npm audit output (follow-redirects advisory GHSA-r4q5-vmmm-2653)  
Problem:
- follow-redirects vulnerable version present transitively.  
Why it matters:
- Header leakage on cross-domain redirects is possible in affected call patterns.  
Evidence:
- npm audit reported 1 moderate vulnerability with fix available.  
Fix:
- Upgrade lockfile/transitive dependency or enforce override to patched version.  
Priority: Next

**Low**

[Inconsistent Auth Secret Hardening Across Modules]  
Category: Security  
Severity: Low  
Confidence: Confirmed  
Location: auth.js, jwt.ts  
Problem:
- Shared data auth helper still has unconditional insecure default fallback.
- Web JWT module throws in production for insecure secret.  
Why it matters:
- If shared helper gets reused in runtime auth paths, insecure behavior can leak into prod.  
Evidence:
- Different secret-handling behavior across modules.  
Fix:
- Standardize secret policy in one module and remove permissive fallback from shared auth helper.  
Priority: Later

**Observations / Smells**

[Operational Health Endpoints Are Not Clearly Production-Grade]  
Category: Operations  
Severity: Low  
Confidence: Suspected  
Location: route.ts, route.ts  
Problem:
- Health-like endpoints are dev-only admin surfaces rather than explicit prod liveness/readiness endpoints.  
Why it matters:
- Incident triage and platform probes may rely on ad-hoc signals/log scraping.  
Evidence:
- Admin endpoints return 404 outside development.  
Fix:
- Add explicit /healthz and /readyz endpoints with minimal dependency checks.  
Priority: Later

---

**3. Dead Code / Waste Register**

| item | type of waste | why removable | removal confidence | dependency check before removal |
|---|---|---|---|---|
| security-headers.ts createSecurityHeaders | dead | no call sites found | high | verify no dynamic import usage |
| middleware.ts vs security-headers.ts | duplicate | two header sources for same concern | high | confirm edge-runtime compatibility constraints |
| route.ts + [web/src/app/api/cards/[gameId]/route.ts](web/src/app/api/cards/[gameId]/route.ts) shared helper blocks | duplicate | near-identical filtering/parsing logic maintained twice | high | extract shared module and regression test both endpoints |
| source-string contract tests in api-admin-model-health.test.js and peers | speculative/low-value | validate text tokens, not behavior | medium | preserve a minimal static policy test set |
| auth-disabled commented blocks in page.tsx, page.tsx | obsolete/config debt | encourages permanent bypass state | medium | confirm business intent for public/private access |

---

**4. Performance Hotspots (Ranked)**

1. route-handler.ts  
Likely cause: oversized request path, many sequential DB reads + parse/merge passes.  
Impact: server latency spikes and timeout fallback frequency under load.  
Easiest fix: split DB-query stages and parallelize independent reads; lower API_GAMES_MAX_CARD_ROWS default.  
Deeper fix: precompute/materialize high-cost joins with worker snapshots.

2. route.ts  
Likely cause: multiple CTE/count queries + ledger query + payload parsing per request.  
Impact: high DB CPU and response time variability.  
Easiest fix: cache filtered ID set and summary separately; avoid repeated count paths unless diagnostics requested.  
Deeper fix: materialized reporting table maintained by worker.

3. route.ts and [web/src/app/api/cards/[gameId]/route.ts](web/src/app/api/cards/[gameId]/route.ts)  
Likely cause: repeated JSON predicate logic and duplicated query branches.  
Impact: wasted CPU and long-term optimization drag.  
Easiest fix: shared query builder + shared payload classifier.  
Deeper fix: normalized persisted contract fields to remove repeated json_extract inference.

4. rate-limiter.ts  
Likely cause: in-memory per-process limiter and weak fallback keying.  
Impact: uneven throttling, false positives, bypass opportunities.  
Easiest fix: trusted IP derivation and strict fallback keys.  
Deeper fix: distributed limiter with central counters.

5. db-init.ts  
Likely cause: placeholder init does not verify ready state and gives false readiness signal.  
Impact: startup/readiness ambiguity, operational confusion.  
Easiest fix: real readiness probe with explicit DB open/health check.  
Deeper fix: central startup orchestration with health contract.

---

**5. Architecture Friction Map**

Duplicated logic:
- Cards query/filter/payload interpretation duplicated across route.ts and [web/src/app/api/cards/[gameId]/route.ts](web/src/app/api/cards/[gameId]/route.ts).

Broken ownership:
- Security policy ownership split between middleware and API security modules ([middleware headers](web/src/middleware.ts#L38) vs security-headers.ts).
- Route validation registry is decoupled from route implementations ([validation map](web/src/lib/api-security/validation.ts#L6)).

Unstable contracts:
- Auth is controlled by route-local feature flags rather than a global protected-route contract ([games auth gate](web/src/lib/games/route-handler.ts#L1712)).
- Query param policy is manual and easy to drift.

Dangerous change zones:
- route-handler.ts and route.ts are large enough that local fixes risk cross-feature regressions.

---

**6. Test Gap Map**

Missing tests by business criticality:
1. Auth enforcement integration tests for protected routes when ENABLE_AUTH_WALLS is off/on.
2. Proxy-trust/IP spoof tests for rate limiter and token route allowlist.
3. Behavioral validation tests for query-validation registry against all performSecurityChecks routes.
4. End-to-end error redaction tests (no raw internal error leakage).
5. Load tests for /api/games and /api/results.

False confidence currently:
- Source-contract tests assert text presence, not runtime behavior (examples above).

First 10 tests to add:
1. /api/performance accepts valid market/days query and rejects invalid values with explicit error.
2. /api/model-outputs?sport=mlb path works and is not blocked by generic validator.
3. /api/games unauthorized when auth wall required.
4. /api/cards unauthorized when auth wall required.
5. /api/cards/[gameId] always returns rate-limit headers on success and failure.
6. /api/performance returns rate-limit headers on error path.
7. getClientIp ignores spoofed forwarded headers when request is untrusted.
8. /api/auth/token allowlist cannot be bypassed by forged x-forwarded-for.
9. API error payloads never include raw exception messages.
10. Regression test that route registration and validator allowlist are in sync.

---

**7. 30-Day Remediation Plan**

Week 1: stop the bleeding
1. Enforce fail-closed auth defaults for protected routes/pages.
2. Patch query-validation map for missing live endpoints and add CI guard.
3. Redact internal errors from all API responses.
4. Patch follow-redirects vulnerability.

Week 2: harden critical paths
1. Replace IP derivation with trusted-proxy model.
2. Tighten token route controls (non-GET, stronger environment guard, explicit prod disable unless emergency override).
3. Add integration tests for auth and validation contracts.

Week 3: remove waste and tighten contracts
1. Extract shared cards query/payload module used by both cards endpoints.
2. Consolidate security header config into one authoritative source.
3. Replace high-risk source-string tests with behavior tests.

Week 4: performance and operability cleanup
1. Decompose /api/games and /api/results into smaller query/service layers.
2. Add per-stage structured timing logs and route-level latency budgets.
3. Add production-grade /healthz and /readyz endpoints with minimal dependency checks.

If you want, I can turn this into a tracked remediation backlog with one ticket per finding (severity, owner, estimate, and test acceptance criteria).