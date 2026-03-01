# Phase 4: Auth & Limits - Context

**Gathered:** 2026-01-30
**Status:** Ready for planning

<domain>
## Phase Boundary

Implement usage limits for the free tier. Track analyses per FPL Team ID and enforce 2 analyses per gameweek. **No payments or Stripe integration** — that's deferred to a future milestone.

</domain>

<decisions>
## Implementation Decisions

### User Identity
- Track users by FPL Team ID only (no accounts, no email signup)
- Each team_id gets its own usage quota
- No browser fingerprinting or device tracking

### Usage Limits
- 2 analyses per gameweek per team_id
- Resets when new gameweek starts (typically Tuesday)
- Count based on successful analysis completions (not attempts)

### Limit Enforcement
- At limit: Block new analyses with countdown to GW reset
- Show cached results from their most recent analysis for that team
- Clear messaging: "Next analysis available when GW26 starts"

### Usage Visibility
- Always show usage count on landing page
- Format: "1 of 2 analyses used this GW"
- Update immediately after analysis completes

### Claude's Discretion
- Storage mechanism (Redis, database, or in-memory with persistence)
- Exact GW reset detection logic (can use FPL API or hardcoded schedule)
- UI styling for limit reached state

</decisions>

<specifics>
## Specific Ideas

- Combo approach: block + show cached results when at limit
- Keep it simple — no accounts means less friction for users
- Usage counter should feel informative, not punishing

</specifics>

<deferred>
## Deferred Ideas

- Stripe payment integration — deferred to post-MVP
- Email accounts and signup — deferred
- Paid tier with unlimited analyses — deferred
- Multi-device session handling — not needed without accounts

</deferred>

---

*Phase: 04-auth-limits*
*Context gathered: 2026-01-30*
