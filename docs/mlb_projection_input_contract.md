# MLB Projection Input Contract — MLB_PITCHER_K

**Reference implementation:** `apps/worker/src/jobs/mlb-k-input-classifier.js`
**WI:** `WORK_QUEUE/WI-0747.md`
**Date:** 2026-04-03

---

## Overview

This document is the canonical source of truth for which MLB pitcher-K inputs are
required to achieve `FULL_MODEL`, which absences permit `DEGRADED_MODEL`, and
which gaps force `FALLBACK`. Any code path that determines `model_quality` for
`MLB_PITCHER_K` cards must be consistent with this contract.

This contract is enforced at runtime via `INV-007` in
`apps/worker/src/audit/audit_invariants.js`.

---

## Input Stages

The MLB pitcher-K projection pipeline assembles inputs in four logical stages
before running the K estimator:

| Stage | Object Name | Purpose |
|-------|-------------|---------|
| 1 | `StarterSkillInput` | Season-level pitcher K rates and whiff metrics |
| 2 | `OpponentContactInput` | Opposing lineup contact/chase profile vs handedness |
| 3 | `LeashInput` | Pitch-count and IP history for early-exit risk |
| 4 | `ProjectionQualityDecision` | Output of `classifyMlbPitcherKQuality` |

### StarterSkillInput shape

```json
{
  "pitcher_id": "string",
  "throws": "R|L",
  "season_starts": 12,
  "k_pct": 0.264,
  "swstr_pct": 0.126,
  "csw_pct": 0.291,
  "pitch_count_avg": 93,
  "ip_avg": 5.8,
  "whiff_proxy": null,
  "source_status": "COMPLETE|PARTIAL|MISSING"
}
```

### OpponentContactInput shape

```json
{
  "team_id": "DET",
  "vs_hand": "L",
  "k_pct_vs_hand": 0.228,
  "contact_pct_vs_hand": 0.762,
  "chase_pct_vs_hand": 0.311,
  "projected_lineup_status": "CONFIRMED|PROJECTED|MISSING",
  "source_status": "COMPLETE|PARTIAL|MISSING"
}
```

### LeashInput shape

```json
{
  "pitcher_id": "string",
  "pitch_count_avg": 93,
  "ip_avg": 5.8,
  "ip_proxy": null,
  "recent_pitch_count_trend": "UP|FLAT|DOWN",
  "leash_class": "SHORT|NORMAL|EXTENDED",
  "source_status": "COMPLETE|PARTIAL|MISSING"
}
```

---

## Field Tier Table

| Field | Tier | Notes |
|-------|------|-------|
| `k_pct` (starter) | `FULL_MODEL_REQUIRED` | Core K rate; no substitute exists |
| `swstr_pct` OR `csw_pct` (starter) | `FULL_MODEL_REQUIRED` | At least one must be a real number; presence of `whiff_proxy` signals neither is available → forces FALLBACK |
| `pitch_count_avg` OR `ip_avg` (leash) | `FULL_MODEL_REQUIRED` | Leash gate; `ip_proxy` present signals neither real value is available → forces FALLBACK |
| `k_pct_vs_hand` (opponent) | `FULL_MODEL_REQUIRED` | Must be handedness-matched; generic opponent K% is not acceptable |
| `contact_pct_vs_hand` (opponent) | `FULL_MODEL_REQUIRED` | Contact profile vs handedness; absent → forces FALLBACK |
| `chase_pct_vs_hand` (opponent) | `DEGRADED_OK` | Absent → `DEGRADED_MODEL`; model still runs with reduced certainty |
| `projected_lineup_status` = `CONFIRMED` | `DEGRADED_OK` | `PROJECTED` (not `CONFIRMED`) lineup → `DEGRADED_MODEL` |
| Park / weather overlay | `DEGRADED_OK` | Absent → `DEGRADED_MODEL`; typically low-weight for K-only model |
| `whiff_proxy` | `FALLBACK_TRIGGER` | Presence signals real `swstr_pct`/`csw_pct` unavailable; disqualifies FULL_MODEL |
| `ip_proxy` | `FALLBACK_TRIGGER` | Presence signals real leash metrics unavailable; disqualifies FULL_MODEL |

---

## Quality Decision Rules

`classifyMlbPitcherKQuality(inputs)` returns `{ model_quality, hardMissing, proxies, degraded }`.

```js
// Pseudocode matching the implementation in mlb-k-input-classifier.js

if (!starter.k_pct)                              → hardMissing.push('starter_k_pct')
if (!(starter.swstr_pct || starter.csw_pct)):
    whiff_proxy present?                         → proxies.push('starter_whiff_proxy')
    else                                         → hardMissing.push('starter_whiff_metric')
if (!(leash.pitch_count_avg || leash.ip_avg)):
    ip_proxy present?                            → proxies.push('ip_proxy')
    else                                         → hardMissing.push('leash_metric')
if (!opponent.k_pct_vs_hand)                     → hardMissing.push('opp_k_pct_vs_hand')
if (!opponent.contact_pct_vs_hand)               → hardMissing.push('opp_contact_profile')
if (!opponent.chase_pct_vs_hand)                 → degraded.push('opp_chase_pct_missing')
if (opponent.projected_lineup_status === 'PROJECTED') → degraded.push('lineup_projected_not_confirmed')

// Decision
if (hardMissing.length > 0 || proxies.length > 0) → model_quality = 'FALLBACK'
else if (degraded.length > 0)                     → model_quality = 'DEGRADED_MODEL'
else                                              → model_quality = 'FULL_MODEL'
```

---

## FALLBACK Behavior

When `model_quality === 'FALLBACK'`:

- Numeric `k_mean` projection is still emitted (model runs with reduced inputs)
- `play_range` boundaries are tightened — no `STRONG_OVER`/`STRONG_UNDER` classification
- Cards should display "Cap PASS" — do not publish aggressive edge claims
- `prop_decision.degradation_reasons` lists all `hardMissing` + `proxies` entries
- `prop_decision.proxy_fields` lists proxy identifiers used

---

## Pre-Model Audit Log

The runner emits a per-pitcher audit line **before** any `k_mean` calculation:

```json
{
  "pitcher": "Framber Valdez",
  "starter_skill_status": "PARTIAL",
  "opponent_contact_status": "COMPLETE",
  "leash_status": "COMPLETE",
  "missing_fields": ["starter_whiff_metric"],
  "proxy_fields": [],
  "quality_before_projection": "FALLBACK"
}
```

Log prefix: `[MLB_K_AUDIT]`

---

## Open Questions (from WI-0747)

Status: **unanswered — see upstream audit**

1. Does the upstream dataset actually contain opponent contact profile split by
   handedness right now, or is that source not built yet?

2. Are `swstr_pct` and `csw_pct` available in raw starter data feeds, or are
   they currently never ingested (field always null at DB read)?

3. Is `IP_PROXY` triggered because pitch-count history is missing from the DB row,
   or because the leash estimator is not wired for thin-sample starters even when
   sufficient samples exist?
