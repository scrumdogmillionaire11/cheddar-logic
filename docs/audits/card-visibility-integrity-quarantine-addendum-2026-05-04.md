# Card Visibility Integrity Audit — Quarantine Addendum (2026-05-04)

## Purpose

This addendum documents the quarantine classification of historical display-enrollment debt from the baseline audit captured on 2026-05-04 at 11:15:03 UTC.

**Baseline audit:** See [card-visibility-integrity-2026-05-04.md](card-visibility-integrity-2026-05-04.md) for the complete row-level classification.

## Quarantine Classification Rationale

The baseline audit identified 49 rows in the `DISPLAY_LOG_NOT_ENROLLED` bucket. These rows have two distinct origins:

1. **Legacy Quarantined** — Rows created before 2026-05-01 (pre-fix display-enrollment residue)
   - Known debt from historical write-path defects
   - Should not pollute current-path regression counts
   - Classification: non-destructive (no mutation, no deletion)

2. **Current-Path Defect** — Rows created after 2026-05-01 (new/recurring issues)
   - Defects that occurred after the fix deployment
   - Must count against regression health metrics
   - Require investigation and remediation

## Quarantine Contract

### LEGACY_QUARANTINED Bucket

**Cutoff date:** 2026-05-01T00:00:00Z

**Definition:** Rows matching all of:

- `created_at < 2026-05-01T00:00:00Z`
- `visibility_bucket = DISPLAY_LOG_NOT_ENROLLED` OR `visibility_bucket = NOT_DISPLAY_ELIGIBLE`
- Historical marker indicating pre-fix system state

**Treatment:**

- Excluded from current-path regression counts
- Preserved in audit trail for forensic analysis
- No payload mutation or deletion
- Visible in diagnostic reports with quarantine annotation

**Expected behavior:** Zero new rows should enter this bucket after 2026-05-01.

### CURRENT_PATH_DEFECT Bucket

**Definition:** Rows matching all of:

- `created_at >= 2026-05-01T00:00:00Z`
- `visibility_bucket = DISPLAY_LOG_NOT_ENROLLED` OR `visibility_bucket = NOT_DISPLAY_ELIGIBLE`
- OR any other visibility bucket indicating active defect

**Treatment:**

- Included in current-path regression counts
- Tracked as actionable defects requiring investigation
- Subject to triage and remediation workflows
- Visible in diagnostic reports with defect annotation

**Expected behavior:** Low frequency; each new row triggers investigation.

### UNKNOWN_UNCLASSIFIED Bucket

**Definition:** Rows that do not fit known classification contracts

- Ambiguous visibility buckets
- Rows with missing or conflicting signals
- Requires manual review

**Treatment:**

- Never silently treated as "clean"
- Always visible in diagnostic reports
- Requires manual triage before clearance
- May indicate new contract violations requiring ADR

## Implementation Details

### Classification Logic

The `classifyRowQuarantine()` function in `apps/worker/src/jobs/report_settlement_health.js` implements the quarantine classification:

```javascript
function classifyRowQuarantine(row, visibilityBucket, createdAt) {
  const LEGACY_CUTOFF = new Date('2026-05-01T00:00:00Z');
  
  if (visibilityBucket === 'DISPLAY_LOG_NOT_ENROLLED' && createdAt < LEGACY_CUTOFF) {
    return {
      quarantineBucket: 'LEGACY_QUARANTINED',
      reason: 'Pre-fix display-enrollment residue created before cutoff date'
    };
  }
  
  if (
    (visibilityBucket === 'DISPLAY_LOG_NOT_ENROLLED' ||
     visibilityBucket === 'NOT_DISPLAY_ELIGIBLE') &&
    createdAt >= LEGACY_CUTOFF
  ) {
    return {
      quarantineBucket: 'CURRENT_PATH_DEFECT',
      reason: 'New defect detected after fix deployment'
    };
  }
  
  if (visibilityBucket === 'PROJECTION_ONLY' || visibilityBucket === 'ENROLLED') {
    return { quarantineBucket: null, reason: null };
  }
  
  return {
    quarantineBucket: 'UNKNOWN_UNCLASSIFIED',
    reason: `Unclassified row with visibility bucket: ${visibilityBucket}`
  };
}
```

### Diagnostic Output Structure

Settlement health report includes a new `quarantine` section:

```javascript
{
  visibilityIntegrity: {
    quarantine: {
      counts: {
        LEGACY_QUARANTINED: 49,
        CURRENT_PATH_DEFECT: 0,
        UNKNOWN_UNCLASSIFIED: 0
      },
      samples: {
        LEGACY_QUARANTINED: [
          {
            cardId, gameId, sport, cardType, createdAt, displayedAt,
            visibilityBucket: 'DISPLAY_LOG_NOT_ENROLLED',
            quarantineReason: 'Pre-fix display-enrollment residue...',
            officialStatus
          }
        ],
        CURRENT_PATH_DEFECT: [],
        UNKNOWN_UNCLASSIFIED: []
      },
      currentPathDefectCount: 0
    }
  }
}
```

## Acceptance Verification

### Test Coverage

**File:** `apps/worker/src/__tests__/settlement-health-report.test.js`

**Test:** `classifies legacy quarantined vs current-path defect rows correctly`

**Verifies:**

- Quarantine structure exists with three buckets
- Quarantine samples include visibility bucket + reason for traceability
- Enrolled and projection-only rows do NOT appear in quarantine buckets
- Current-path defect count is tracked independently
- Unknown rows are visible, not hidden

**Run:**

```bash
npm --prefix apps/worker test -- src/__tests__/settlement-health-report.test.js
```

## Audit Trail Preservation

### Original Baseline (Immutable)

**File:** `docs/audits/card-visibility-integrity-2026-05-04.md`

- Status: Read-only baseline
- Purpose: Forensic reference
- Modifications: None

### Addendum (This Document)

**File:** `docs/audits/card-visibility-integrity-quarantine-addendum-2026-05-04.md`

- Status: Authoritative quarantine policy
- Purpose: Documents the quarantine split and rationale
- Modifications: May be updated with new insights

### Forward-Path Audits

**Naming:** `docs/audits/card-visibility-integrity-<YYYY-MM-DD>.md`

- Frequency: Weekly or milestone-based
- Reference: Compare against this addendum's quarantine contract

## Non-Destructive Classification Guarantees

- **No payload mutation:** Card JSON never modified; read-only only
- **No settlement recalculation:** Settlement records untouched
- **No hard deletion:** Rows never deleted; additive classification
- **No backdating:** Timestamps never modified; history immutable
- **Visible unknowns:** Unclassifiable rows always surface for review

## References

- **Baseline Audit:** [card-visibility-integrity-2026-05-04.md](card-visibility-integrity-2026-05-04.md)
- **Implementation:** `apps/worker/src/jobs/report_settlement_health.js` — `classifyRowQuarantine()`
- **Tests:** `apps/worker/src/__tests__/settlement-health-report.test.js`
- **Work Item:** WI-1269 — Quarantine Historical Display-Enrollment Debt
