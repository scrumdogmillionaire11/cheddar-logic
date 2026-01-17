# Cheddar Logic LLC

A probabilistic sports analytics decision-support platform that provides statistical insights derived from sports data and public reference markets.

## Overview

Cheddar Logic specializes in abstention-first methodology - identifying when confidence is insufficient for signal generation while delivering transparent, evidence-based analytical insights.

## Core Services

- **Sports Analytics Decision-Support** (80% focus): Probabilistic modeling and market-relative signals
- **Custom Web Development** (20% focus): Technical consulting and development services

## Getting Started

See [.planning/](.planning/) for project requirements and development roadmap.

### Landing Page Frontend (`/web`)

The `web` directory contains the Next.js 14 + TypeScript marketing site.

#### Prerequisites
- Node.js 20+
- npm 10+

#### Install & Run
```bash
cd web
npm install
npm run dev
```

#### Environment Variables
Create a `.env.local` file inside `web/` and set:

| Variable | Description |
| --- | --- |
| `NEXT_PUBLIC_DISCORD_INVITE` | Discord invite URL for CTA buttons |
| `NEXT_PUBLIC_DISCORD_MEMBER_COUNT` | Text used for community size display (e.g., `"412 analysts"`) |
| `NEXT_PUBLIC_ANALYTICS_STATUS` | `online` or `paused`; drives the analytics kill switch banner |
| `NEXT_PUBLIC_ANALYTICS_LAST_UPDATED` | ISO timestamp for the kill switch metadata |

If the status is set to `paused`, analytics visuals collapse while the educational copy stays live.

#### Deployment Notes
- Designed for Vercel/Netlify. Configure the above env vars in each environment.
- Health check endpoint TBD; add before production deployment.
- Contact form currently client-side only. Wire to a serverless function or webhook with CAPTCHA before accepting submissions.

## Community

Join our Discord research community for analytical discussions and methodology insights.

---

*Positioned as analytical infrastructure for research and decision-support purposes.*