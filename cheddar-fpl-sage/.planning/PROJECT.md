# FPL Sage

## What This Is

An AI-powered decision engine for Fantasy Premier League managers that transforms the existing CLI tool into an accessible web application. Positioned as "The AI Coach for FPL" - providing personalized transfer recommendations, chip timing optimization, and captain suggestions with transparent reasoning in under 60 seconds.

**Core Value:** Stop overthinking FPL. Your AI coach tells you exactly what to do, with transparent reasoning, in 60 seconds.

**Current State:** Working CLI tool with data pipeline (collect → normalize → analyze). Needs web frontend and backend API to become accessible product.

## Current Milestone

**Milestone 1: MVP Web Application Launch**
- Target: GW25 (February 2026) - capture 14 gameweeks of value
- Goal: 10,000 users, 500 paid subscribers, $60k ARR

## Requirements

### Validated
- [x] CLI decision engine works and produces actionable recommendations
- [x] Data pipeline (Phase 1-3) collects, normalizes, validates FPL data
- [x] Injury resolution merges FPL + secondary + manual sources
- [x] Chip timing analysis identifies optimal usage windows
- [x] Captain selection with expected points ranking
- [x] Transfer recommendations with reasoning

### Active (MVP Scope)
- [ ] FastAPI backend wrapping existing Python engine
- [ ] React frontend with mobile-first responsive design
- [ ] User authentication via FPL Team ID entry
- [ ] Real-time analysis progress (WebSocket/SSE)
- [ ] Freemium model: 2 free analyses/GW, paid unlimited
- [ ] Stripe payment integration
- [ ] PWA support (installable, offline-capable)

### Out of Scope (Phase 2+)
- Native mobile apps (iOS, Android)
- Wildcard team builder optimizer
- Historical accuracy tracking dashboard
- Social features (league analysis, friend comparisons)
- B2B API tier for content creators
- Multi-language support

## Key Decisions

| Decision | Choice | Rationale | Date |
|----------|--------|-----------|------|
| Tech Stack | React + FastAPI + PostgreSQL | Matches existing Python codebase, modern frontend | 2026-01-19 |
| Hosting | Vercel (frontend) + Railway/AWS (backend) | Cost-effective, scalable, good DX | 2026-01-19 |
| Design System | Dark mode default, clinical aesthetic | Differentiate from playful competitor UIs | 2026-01-19 |
| Freemium Limit | 2 analyses/gameweek free | Balance acquisition vs conversion | 2026-01-19 |
| Pricing | $9.99/month or $79/year | Market research validated | 2026-01-19 |

## Constraints

### Hard Limits
- **Launch by GW25 (Feb 2026)** - miss this and lose 14 GWs of value
- **Budget:** $50-100/month infrastructure (bootstrapped)
- **FPL API:** Must respect rate limits (~10 req/min), no commercial redistribution
- **Solo developer** initially - scope must be achievable

### Technical Constraints
- FPL API is dependency (could change/rate limit)
- Analysis must complete <10 seconds
- Must work on mobile Safari and Chrome Android
- GDPR compliance required for UK/EU users

## Success Metrics

### MVP Success Criteria
- 10,000 total users (free + paid)
- 5% conversion to paid (500 subscribers)
- $60k ARR by season end (May 2026)
- 4.5+ user satisfaction rating
- 70%+ recommendation accuracy
- <5% monthly churn (paid)

### Tracking
- Weekly: MRR, conversion rate, new users, CAC
- Monthly: LTV, churn, NPS, accuracy reports
- Daily: API uptime, analysis speed, error rate

---

*Project initialized: 2026-01-23*
