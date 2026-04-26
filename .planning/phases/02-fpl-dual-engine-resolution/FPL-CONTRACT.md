# FPL Dual-Engine Contract (Option B: Keep Separate)

## Ownership & Responsibility

### Worker Engine (Node.js)
**Owner:** apps/worker/src/models/fpl.js  
**Role:** Frontend prediction cache, quick lookups  
**Responsibility:** Maintain compatibility with Sage outputs  

### Sage Engine (Python)
**Owner:** cheddar-fpl-sage/  
**Role:** Ground truth inference, model training, updates  
**Responsibility:** Expose stable API for Worker to consume  

## API Boundary

### Sage → Worker Contract
**Endpoint:** Sage publishes predictions as JSON API  
**Format:** 
```json
{
  "player_id": 1,
  "predicted_points": 7.5,
  "confidence": 0.82,
  "model_version": "1.0.0",
  "timestamp": "2026-03-04T12:00:00Z"
}

Guarantee: Outputs are stable and versioned. Breaking changes require major version bump.

Worker → Sage Contract
Consumer: Worker JS queries Sage for predictions
Frequency: Cache refresh interval (configurable)
Fallback: Worker maintains 24h cache on network failure

Integration Points
Startup: Worker loads cached predictions from Sage on app startup
Refresh: Worker periodically polls Sage for updates (every 1h default)
Conflict Resolution: Sage is source of truth; Worker defers on mismatch
Testing Strategy
Unit Tests: Worker logic isolated with mock Sage responses
Integration Tests: Worker + Sage running; verify predictions flow
Contract Tests: Validate JSON schema compliance at boundary


Maintenance Checklist
 Sage API versioning documented in cheddar-fpl-sage/API.md
 Worker import endpoints verified weekly
 Schema validation tests passing