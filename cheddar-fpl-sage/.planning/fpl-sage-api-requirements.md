# FPL Sage API Requirements & Integration Specification

**Date:** February 24, 2026  
**Status:** Requirements Document for Cheddar Logic Integration  
**Audience:** FPL Sage Developers, Cheddar Logic Backend Team

---

## Overview

This document outlines what FPL Sage must expose via REST API to be fully integrated into the Cheddar Logic platform. FPL Sage currently has a working FastAPI backend with analysis and WebSocket capabilities. This spec formalizes the endpoints and data formats required for seamless integration into the sports betting dashboard.

---

## Integration Goals

1. **Trusted Internal Integration:** Cheddar Logic remains the auth boundary; FPL Sage does not implement a separate auth service.
2. **Dashboard Consumption:** Expose structured data for display in unified sports betting dashboard
3. **Real-Time Updates:** Stream analysis progress and results via WebSocket
4. **Data Export:** Provide dashboard-friendly JSON feeds for external integrations
5. **Historical Tracking:** Persist analysis results for performance tracking and retention

## MVP Scope Decisions (Updated: February 25, 2026)

- Auth sunset remains in effect for MVP:
  - FPL Sage does **not** implement `POST /auth/validate-token`.
  - Endpoint is intentionally absent; contract tests assert `404`.
- Durable long-horizon analytics persistence is **post-launch**:
  - MVP uses Redis-backed execution state plus in-memory cache for active jobs/short retention.
  - Post-launch adds DB-backed retention for long-term history/performance analytics.

---

## Current FPL Sage Capability (as of Feb 2026)

### Existing Endpoints (Base URL: `http://localhost:8001/api/v1/`)

| Endpoint | Method | Purpose | Status |
| --- | --- | --- | --- |
| `/analyze/interactive` | POST | Trigger FPL analysis with team & parameters | ✅ Exists |
| `/analyze/{analysis_id}/projections` | GET | Detailed player projections & recommendations | ✅ Exists |
| `/dashboard/{analysis_id}/simple` | GET | Dashboard-friendly structured data | ✅ Exists |
| `/analyze/{analysis_id}/stream` | WS | Real-time progress streaming | ✅ Exists |

### Current Data Sources

- **FPL API:** Live player data, team selections, fixture info
- **Internal Models:** Transfer recommendations, chip timing, captain suggestions
- **Manual Overrides:** Config file for chips, transfers, injuries

---

## Required API Endpoints for Cheddar Logic Integration

### 1. Access Boundary (Auth Sunset Decision)

Decision:
- FPL Sage will **not** implement `POST /auth/validate-token`.
- Cheddar Logic remains the single authentication/authorization boundary.
- FPL Sage is treated as an internal trusted service behind Cheddar Logic.

Implementation impact:
- No auth router in FPL Sage.
- No token validation logic in FPL Sage.
- No route-level auth middleware/dependencies in FPL Sage.

Required guardrails:
- Restrict CORS and network ingress to Cheddar Logic-controlled origins/infrastructure.
- Accept optional upstream metadata (`user_id`, `source`) for tracing only (not authorization).
- Keep request logging free of secrets.

---

### 2. Analysis Triggering

**Endpoint:** `POST /analyze/interactive`

**Purpose:** Trigger an FPL analysis. Already exists but must support request/response format below.

**Request:**
```json
{
  "team_id": 1234567,
  "free_transfers": 1,
  "available_chips": ["bench_boost", "triple_captain"],
  "risk_posture": "balanced",
  "injury_overrides": [
    {
      "player_name": "Haaland",
      "status": "DOUBTFUL",
      "chance": 50
    }
  ],
  "user_id": "user_123",
  "source": "cheddar_logic_dashboard"
}
```

**Response (202 Accepted):**
```json
{
  "analysis_id": "a1b2c3d4-e5f6-47g8-h9i0-j1k2l3m4n5o6",
  "status": "queued",
  "team_id": 1234567,
  "created_at": "2026-02-24T10:30:00Z",
  "estimated_duration_seconds": 45
}
```

**Notes:**
- Analysis ID should be UUID v4 for reliability
- Should immediately return without blocking (async processing)
- Status progression: `queued` → `analyzing` → `complete` / `failed`

---

### 3. Analysis Results (Detailed)

**Endpoint:** `GET /analyze/{analysis_id}`

**Purpose:** Retrieve complete analysis results including all recommendations.

**Response (200 Success):**
```json
{
  "analysis_id": "a1b2c3d4-e5f6-47g8-h9i0-j1k2l3m4n5o6",
  "team_id": 1234567,
  "status": "complete",
  "created_at": "2026-02-24T10:30:00Z",
  "completed_at": "2026-02-24T10:31:22Z",
  "gameweek": 25,
  "season": "2025-26",
  
  "transfer_recommendations": [
    {
      "id": "transfer_001",
      "action": "remove",
      "player_id": 123,
      "player_name": "Bruno Fernandes",
      "current_price": 8.5,
      "reason": "Injury - no return date",
      "priority": "URGENT",
      "expected_points_gained": 2.3,
      "confidence": 0.92
    },
    {
      "id": "transfer_002",
      "action": "add",
      "player_id": 456,
      "player_name": "Kevin De Bruyne",
      "price": 8.3,
      "position": "MID",
      "reason": "Home vs Brighton, excellent form",
      "priority": "HIGH",
      "expected_points": 8.1,
      "confidence": 0.89
    }
  ],
  
  "chip_strategy": {
    "bench_boost": {
      "recommended": false,
      "rationale": "Current bench value too low",
      "current_window_value": 3.2,
      "best_window_gw": 27,
      "best_window_value": 9.8
    },
    "triple_captain": {
      "recommended": true,
      "rationale": "Optimal for GW26 fixtures",
      "best_player": "Salah",
      "expected_boost": 6.5
    },
    "free_hit": {
      "available": false,
      "rationale": "Already used in GW12"
    }
  },
  
  "captain_recommendation": {
    "primary": {
      "player_id": 234,
      "player_name": "Mohamed Salah",
      "expected_points": 9.4,
      "ownership": 45.2,
      "form": "excellent",
      "fixture": "WHU (H)",
      "fixture_difficulty": 2,
      "confidence": 0.91,
      "rationale": "Strong fixture, elite form, differential potential low"
    },
    "vice": {
      "player_id": 567,
      "player_name": "Erling Haaland",
      "expected_points": 8.8,
      "ownership": 67.1,
      "form": "good",
      "fixture": "BOU (H)",
      "fixture_difficulty": 2,
      "confidence": 0.85
    }
  },
  
  "team_weaknesses": [
    {
      "weakness": "missing_fpl_premiums",
      "description": "Low coverage of top-5 premium assets",
      "affected_player_ids": [234, 567],
      "severity": "HIGH"
    },
    {
      "weakness": "defensive_rotation_risk",
      "description": "Multiple defensive assets with rotation risk",
      "affected_player_ids": [789, 890],
      "severity": "MEDIUM"
    }
  ],
  
  "risk_flags": [
    {
      "flag": "injury_uncertainty",
      "player_id": 123,
      "player_name": "Bruno Fernandes",
      "description": "Missing player with no clear return date",
      "mitigation": "Consider as forced transfer opportunity"
    }
  ],
  
  "summary": {
    "total_transfers_recommended": 4,
    "urgent_transfers": 1,
    "expected_team_points_improvement": 6.8,
    "overall_team_health": "good",
    "readiness_for_deadline": "ready",
    "confidence_score": 0.87
  }
}
```

---

### 4. Dashboard-Friendly Summary

**Endpoint:** `GET /analyze/{analysis_id}/dashboard`

**Purpose:** Return simplified, dashboard-optimized data (less detail, faster rendering).

**Response (200 Success):**
```json
{
  "analysis_id": "a1b2c3d4-e5f6-47g8-h9i0-j1k2l3m4n5o6",
  "team_id": 1234567,
  "status": "complete",
  "gameweek": 25,
  
  "quick_actions": [
    {
      "action": "transfer",
      "priority": "URGENT",
      "from_player": "Bruno Fernandes",
      "to_player": "Kevin De Bruyne",
      "gain": 2.3
    }
  ],
  
  "captain": {
    "player": "Mohammed Salah",
    "expected_points": 9.4,
    "confidence": 0.91
  },
  
  "chips": {
    "bench_boost": "save",
    "triple_captain": "use",
    "free_hit": "not_available"
  },
  
  "health_score": 0.87,
  "key_risks": ["injury_uncertainty", "defensive_rotation"]
}
```

---

### 5. Real-Time Progress Streaming

**Endpoint:** `WS /analyze/{analysis_id}/stream`

**Purpose:** Stream real-time progress updates during analysis execution. Already exists but must follow spec below.

**Message Format (JSON):**

```json
{
  "type": "progress",
  "phase": "injury_analysis",
  "progress": 35,
  "message": "Analyzing injury data from secondary feeds...",
  "timestamp": "2026-02-24T10:30:15Z"
}
```

**Possible Phases:**
- `initializing` (0-5%)
- `data_collection` (5-20%)
- `injury_analysis` (20-35%)
- `transfer_optimization` (35-60%)
- `chip_strategy` (60-75%)
- `captain_analysis` (75-90%)
- `finalization` (90-100%)

**Completion Message:**
```json
{
  "type": "complete",
  "analysis_id": "a1b2c3d4-e5f6-47g8-h9i0-j1k2l3m4n5o6",
  "status": "success",
  "timestamp": "2026-02-24T10:31:22Z"
}
```

**Error Message:**
```json
{
  "type": "error",
  "error": "Failed to fetch FPL API data",
  "details": "Connection timeout after 30 seconds",
  "timestamp": "2026-02-24T10:31:22Z"
}
```

---

### 6. Health & Status Check

**Endpoint:** `GET /health`

**Purpose:** FPL Sage service health check for monitoring/alerting.

**Response (200 Success):**
```json
{
  "status": "healthy",
  "timestamp": "2026-02-24T10:35:00Z",
  "components": {
    "fpl_api": "healthy",
    "database": "healthy",
    "analysis_engine": "healthy"
  },
  "version": "2.0.0",
  "uptime_hours": 72.5
}
```

**Response (503 Service Unavailable):**
```json
{
  "status": "degraded",
  "timestamp": "2026-02-24T10:35:00Z",
  "components": {
    "fpl_api": "unavailable",
    "database": "healthy",
    "analysis_engine": "healthy"
  },
  "message": "FPL API temporarily unreachable"
}
```

---

## Data Models & Schemas

### Analysis Request Object

```typescript
interface AnalysisRequest {
  team_id: number;
  free_transfers: number;
  available_chips: string[]; // ["bench_boost", "free_hit", "triple_captain"]
  risk_posture: "conservative" | "balanced" | "aggressive";
  injury_overrides?: InjuryOverride[];
  user_id?: string;
  source?: string;
}

interface InjuryOverride {
  player_name: string;
  status: "FIT" | "DOUBTFUL" | "OUT";
  chance?: number; // 0-100
}
```

### Transfer Recommendation Object

```typescript
interface TransferRecommendation {
  id: string;
  action: "remove" | "add";
  player_id: number;
  player_name: string;
  position: "GK" | "DEF" | "MID" | "FWD";
  current_price?: number; // For player being removed
  price?: number; // For player being added
  reason: string;
  priority: "URGENT" | "HIGH" | "MEDIUM" | "LOW";
  expected_points_gained?: number; // For this specific transfer
  expected_points?: number; // For new player
  confidence: number; // 0-1
}
```

### Chip Strategy Object

```typescript
interface ChipStrategy {
  [chip_name: string]: {
    recommended: boolean;
    rationale: string;
    current_window_value?: number;
    best_window_gw?: number;
    best_window_value?: number;
    best_player?: string; // For Triple Captain
    expected_boost?: number;
    available?: boolean;
  };
}
```

---

## Error Handling Requirements

### Standard Error Response Format

All endpoints should return errors in this format:

```json
{
  "error": true,
  "error_code": "INVALID_TEAM_ID",
  "message": "Team ID 9999999 not found in FPL system",
  "details": {
    "field": "team_id",
    "value": 9999999
  },
  "timestamp": "2026-02-24T10:35:00Z"
}
```

### Common Error Codes

| Code | HTTP Status | Meaning |
| --- | --- | --- |
| `INVALID_TEAM_ID` | 400 | Team ID doesn't exist in FPL |
| `ANALYSIS_NOT_FOUND` | 404 | Analysis ID doesn't exist |
| `RATE_LIMITED` | 429 | Too many requests (infrastructure protection only, not user quota) |
| `FPL_API_ERROR` | 502 | External FPL API unreachable |
| `ANALYSIS_FAILED` | 500 | Internal analysis engine error |

---

## Usage Policy

- No per-user or per-team usage quotas.
- Do not block analysis requests based on run-count limits.
- If rate-limiting exists, it should be infrastructure-level abuse protection only.

---

## Integration Checklist for FPL Sage

- [ ] Verify `/analyze/interactive` request/response format matches spec
- [ ] Verify `/analyze/{analysis_id}` returns complete data format
- [ ] Implement `/analyze/{analysis_id}/dashboard` for simplified output
- [ ] Verify `/analyze/{analysis_id}/stream` WebSocket messages follow spec
- [ ] Implement `/health` status check endpoint
- [ ] Standardize all error responses to spec format
- [ ] Add request/response logging for debugging
- [ ] Implement proper CORS for cheddar-logic domain
- [ ] Add API documentation (Swagger/OpenAPI)
- [ ] Test all endpoints under load
- [ ] Set up monitoring for FPL API availability

---

## Security & Compliance Requirements

### Access Control Boundary
- Authentication and authorization are enforced by Cheddar Logic.
- FPL Sage does not validate end-user tokens directly.
- FPL Sage should only be reachable from trusted Cheddar Logic infrastructure.

### Data Privacy
- Never expose team IDs or user data in logs
- Sanitize error messages (no path traversal hints)
- Implement audit logging for all analysis requests

### Rate Limiting
- Infrastructure-level protection only (no per-user/team quotas)
- If enabled, return `429` with `Retry-After` header when exceeded

### CORS
- Allow origins: `https://cheddarlogic.com`, `http://localhost:3000`
- Allow methods: GET, POST, OPTIONS
- Allow headers: Authorization, Content-Type

---

## Monitoring & Observability

### Key Metrics to Track
1. **Analysis Success Rate** (% of queued analyses that complete successfully)
2. **Analysis Latency** (p50, p95, p99 times)
3. **FPL API Availability** (% uptime)
4. **WebSocket Connection Stability** (% of streams that complete without errors)
5. **API Error Rate by Code** (track specific error types)

### Logging
- Request/response body (except secrets)
- Latency per phase
- FPL API call details
- Analysis results digest (not full payload)

---

## Timeline & Milestones

**By March 31, 2026:**
- All endpoints implemented per spec
- Health monitoring in place

**By April 30, 2026:**
- Full integration into cheddar-logic/web
- FPL Sage accessible from main platform
- Access control enforced at Cheddar Logic boundary

**By June 30, 2026:**
- FPL Sage in unified sports betting dashboard
- Performance tracking visible to users
- Webhook notifications working

---

## Questions & Clarifications Needed

1. **Database:** Should FPL Sage use same database as Cheddar Logic, or separate? (Recommend: separate with sync)
2. **Webhook Notifications:** Should FPL Sage support webhooks for results delivery? (E.g., to Discord)
3. **Bulk Analysis:** Should there be endpoint to analyze multiple teams in one request?
4. **Custom Models:** Should we expose optional custom injury threshold profiles?

---

**Document Version:** 1.0  
**Last Updated:** February 24, 2026  
**Next Review:** April 1, 2026
