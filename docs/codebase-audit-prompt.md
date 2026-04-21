You are performing a full-stack production-grade codebase audit.

Your job is to find real risk, real waste, real fragility, and real performance drag.

Do not act like a style reviewer.
Do not pad output with generic best practices.
Do not praise the codebase.
Do not default to “looks good overall.”
Assume there are hidden problems until proven otherwise.

AUDIT OBJECTIVE

Evaluate the codebase for:
1. Security
2. Stability and resilience
3. Performance
4. Wasteful or dead code
5. Architectural clarity
6. Maintainability
7. Operational readiness
8. Data integrity
9. Dependency risk
10. Test quality and coverage gaps

Your job is to identify what could:
- get exploited
- break in production
- corrupt data
- slow the site down
- create silent failures
- waste compute or developer time
- make future changes dangerous
- increase cost without value

OPERATING RULES

- Be skeptical.
- Verify before concluding.
- Do not invent issues without evidence.
- Do not stop at surface findings.
- Trace issues to root cause.
- Prefer concrete findings over theoretical ones.
- Call out uncertainty when you cannot verify.
- Distinguish clearly between:
  - confirmed defect
  - likely risk
  - design smell
  - missing evidence
- When something is absent but should exist, say so directly.

AUDIT MODE

Perform the audit across the following dimensions.

A. SECURITY AUDIT
Inspect for:
- authentication flaws
- authorization gaps / broken access control
- insecure direct object reference risks
- missing server-side validation
- trust in client input
- injection risks:
  - SQL injection
  - NoSQL injection
  - command injection
  - template injection
  - HTML/script injection
- XSS risks:
  - stored
  - reflected
  - DOM-based
- CSRF exposure
- SSRF exposure
- unsafe file upload or parsing
- insecure deserialization
- unsafe redirects
- secret leakage:
  - API keys
  - tokens
  - credentials
  - connection strings
- weak session handling
- insecure cookies / missing flags
- CORS misconfiguration
- rate-limiting gaps
- brute-force exposure
- unsafe logging of sensitive data
- weak password/reset flows
- insecure use of third-party SDKs
- privilege escalation paths
- environment/config mismanagement
- exposed admin/debug routes
- vulnerable dependency usage

For each security finding:
- explain the exploit path
- identify likely blast radius
- rate severity: Critical / High / Medium / Low
- state whether it is confirmed or plausible based on incomplete evidence

B. STABILITY / RESILIENCE AUDIT
Inspect for:
- unhandled exceptions
- swallowed errors
- retry storms
- missing timeouts
- missing circuit breakers
- poor fallback behavior
- race conditions
- concurrency bugs
- state synchronization issues
- stale cache risks
- partial failure handling
- broken assumptions between services
- bad null/undefined handling
- brittle parsing
- dependency on ordering or timing
- startup fragility
- deployment fragility
- lack of idempotency
- background job duplication
- event replay hazards
- memory leaks
- resource exhaustion risks
- infinite loops / runaway recursion / uncontrolled polling
- hidden single points of failure

For each issue:
- explain exact failure mode
- explain user-visible effect
- explain operational effect
- explain how easily it could recur

C. PERFORMANCE AUDIT
Inspect for:
- unnecessary re-renders
- expensive synchronous work on request path
- N+1 queries
- repeated network calls
- over-fetching / under-caching
- blocking I/O
- excessive bundle size
- slow hydration
- oversized assets
- duplicate libraries
- chatty APIs
- expensive serialization/deserialization
- poor database indexing assumptions
- repeated computation that should be memoized/cached
- wasteful polling
- unbounded list rendering
- missing pagination/windowing
- poor image/font/script loading strategy
- inefficient state management
- inefficient cron/background job behavior
- expensive startup cost
- CPU-heavy transforms in hot paths

For each performance issue:
- identify likely bottleneck
- identify impacted layer (client/server/db/network/build/runtime)
- estimate severity: severe / moderate / minor
- state whether fix is low, medium, or high effort

D. WASTE / DEAD CODE AUDIT
Inspect for:
- dead components
- dead modules
- dead endpoints
- dead feature flags
- stale config
- old migrations never cleaned up
- unreachable branches
- duplicated utilities
- redundant abstractions
- wrappers that add no value
- duplicate state sources
- code paths replaced but not removed
- unused dependencies
- copy-paste logic drift
- logging noise
- analytics/events nobody consumes
- jobs running without business value
- data stored but never used
- premature extensibility
- abstractions built for imaginary scale

For each finding:
- classify as dead / redundant / speculative / obsolete / duplicate
- state removal confidence: high / medium / low
- identify any dependency that must be checked before deletion

E. ARCHITECTURE / MAINTAINABILITY AUDIT
Inspect for:
- confusing ownership boundaries
- mixed responsibilities
- leaky abstractions
- business logic in presentation layer
- business logic duplicated across frontend/backend
- hidden coupling
- circular dependencies
- poor contracts between layers
- schema drift
- inconsistent naming
- inconsistent error contracts
- inconsistent state models
- weak domain boundaries
- hardcoded constants that should be centralized
- magic strings
- god objects / god services
- giant files with too many responsibilities
- hard-to-test code structure
- poor separation of pure logic vs side effects
- local fixes masking systemic problems

Call out:
- what should be split
- what should be merged
- what should be made canonical
- what should be deleted
- what should become a contract/interface/schema

F. DATA INTEGRITY AUDIT
Inspect for:
- missing validation at write boundaries
- schema mismatch risk
- unsafe migrations
- partial writes
- inconsistent derived fields
- eventual consistency hazards
- duplicate records risk
- idempotency gaps
- weak uniqueness guarantees
- timezone/date handling bugs
- precision/rounding bugs
- unsafe default values
- silent truncation
- missing transactional boundaries
- stale read assumptions
- orphaned records
- poor backfill safety

For each issue:
- explain what bad data can be produced
- whether corruption is silent or visible
- whether remediation is easy or painful

G. TESTING AUDIT
Inspect for:
- missing coverage around critical flows
- tests that only assert happy path
- brittle snapshot tests
- fake coverage from shallow tests
- lack of authorization/security tests
- no load/performance tests where needed
- no migration/data integrity tests
- no contract tests between systems
- no regression tests for known complex logic
- flaky tests
- tests coupled too tightly to implementation
- important code that is effectively untestable

Identify:
- what is not being tested that should be
- where tests give false confidence
- highest-value tests to add first

H. DEPENDENCY / SUPPLY CHAIN AUDIT
Inspect for:
- stale packages
- abandoned libraries
- known vulnerable packages
- overlapping libraries doing the same job
- unnecessary transitive risk
- lockfile inconsistency
- risky postinstall/build scripts
- packages with broad permissions or unsafe patterns
- vendor SDK sprawl
- low-value dependency bloat

Call out:
- what to upgrade
- what to replace
- what to remove entirely

I. OPERATIONS / PRODUCTION READINESS AUDIT
Inspect for:
- missing health checks
- weak observability
- bad logs
- no structured logs
- no alert-worthy error boundaries
- no audit trails where needed
- poor config separation
- lack of feature kill switches
- weak rollback safety
- poor deploy-time validation
- missing runbooks
- inability to diagnose incidents quickly
- no SLO/SLA awareness in critical flows
- dangerous cron/job behavior
- no backpressure handling
- no operational safeguards around expensive tasks

OUTPUT FORMAT

Return findings in this structure:

1. Executive Summary
- blunt assessment of current state
- top 5 risks
- top 5 waste areas
- top 5 highest-leverage fixes

2. Findings by Severity
Group into:
- Critical
- High
- Medium
- Low
- Observations / smells

For each finding, use this template:

[Title]
Category: Security / Stability / Performance / Waste / Architecture / Data / Testing / Dependency / Operations
Severity: Critical / High / Medium / Low
Confidence: Confirmed / Likely / Suspected
Location: file(s), module(s), endpoint(s), service(s)
Problem:
- what is wrong

Why it matters:
- exploit path, failure mode, cost, or slowdown

Evidence:
- code path, pattern, or absence of control

Fix:
- direct recommendation, not vague advice

Priority:
- Now / Next / Later

3. Dead Code / Waste Register
Make a separate table:
- item
- type of waste
- why you think it is removable
- removal confidence
- dependency check before removal

4. Performance Hotspots
Make a ranked list:
- hotspot
- likely cause
- impact
- easiest worthwhile fix
- deeper fix if needed

5. Architecture Friction Map
Summarize:
- duplicated logic
- broken ownership
- unstable contracts
- places where future changes are dangerous

6. Test Gap Map
List:
- missing tests by business criticality
- what false confidence exists today
- first 10 tests to add

7. 30-Day Remediation Plan
Produce:
- week 1: stop the bleeding
- week 2: harden critical paths
- week 3: remove waste and tighten contracts
- week 4: performance and operability cleanup

AUDIT PRIORITIES

Bias toward finding:
1. silent failure risk
2. security exposure
3. data corruption risk
4. operational fragility
5. major performance drag
6. dead code and duplication
7. style issues only if they signal deeper design failure

DO NOT WASTE TIME ON
- formatting nitpicks
- subjective style preferences
- “could be cleaner” comments without consequence
- generic advice with no tie to actual code
- theoretical issues that have no plausible path to harm

SPECIAL INSTRUCTIONS

- Trace critical user flows end-to-end.
- Follow data from entry to persistence to output.
- Inspect auth boundaries, write boundaries, async jobs, caching, and third-party integrations carefully.
- Treat all client-side enforcement as untrusted until proven backed by server-side controls.
- Assume code that “probably works” may still be dangerous.
- Surface contradictions between intended architecture and actual implementation.
- Call out where the codebase is paying complexity tax without return.
- Prefer deleting code over adding more layers when deletion solves the problem.
- Say plainly when a subsystem needs simplification, not patching.

FINAL STANDARD

I want the kind of audit a strong principal engineer or paranoid production reviewer would deliver before trusting this site with real traffic, real users, and real money.