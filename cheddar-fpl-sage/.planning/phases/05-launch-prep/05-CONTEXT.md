# Phase 5: Launch Prep - Context

**Gathered:** 2026-01-30
**Status:** Ready for planning

<domain>
## Phase Boundary

Production deployment and go-live readiness for FPL Sage. Deploy frontend and backend to production infrastructure, set up monitoring and alerting, create legal documents, and prepare for launch traffic.

Not in scope: Payment integration, user accounts, marketing campaigns, post-launch iteration.

</domain>

<decisions>
## Implementation Decisions

### Deployment Infrastructure
- **Domain:** cheddarlogic.com/fpl-sage (user owns domain)
- **DNS:** Cloudflare (already configured)
- **Frontend:** Deploy to Vercel with `/fpl-sage` base path
- **Backend:** Deploy to Railway (includes Redis support)
- **API routing:** Either `cheddarlogic.com/api/*` or `api.cheddarlogic.com` subdomain

### PWA Capabilities
- **No PWA features** — this is a web-only application
- No offline mode, no install prompts, no service worker complexity
- Just show "you're offline" message if connection lost

### Monitoring & Alerting
- **Alert channel:** Discord webhook
- **Analytics:** Privacy-friendly basic analytics (Plausible or Umami)
- **Error tracking:** Sentry or similar for crash/error logging

### Legal Documents
- **Approach:** AI-generated drafts customized for FPL Sage
- **Audience:** Global (FPL players worldwide)
- **GDPR:** Follow best practices even without EU-specific targeting

### Claude's Discretion
- Alert thresholds (what triggers Discord notifications)
- Legal document tone (friendly vs formal)
- Cookie consent approach (lean toward cookieless analytics if possible)
- Uptime monitoring tool choice
- CI/CD pipeline configuration

</decisions>

<specifics>
## Specific Ideas

- User wants path-based routing: `cheddarlogic.com/fpl-sage` not a subdomain
- Domain is already on Cloudflare — leverage existing DNS setup
- Keep it simple: no native app complexity, no offline features
- Discord is the alerting channel (not email, not Slack)

</specifics>

<deferred>
## Deferred Ideas

None — discussion stayed within phase scope

</deferred>

---

*Phase: 05-launch-prep*
*Context gathered: 2026-01-30*
