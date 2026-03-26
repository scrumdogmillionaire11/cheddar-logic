# 03 — Leash rules

## Rule

The leash tier classifies the realistic ceiling on a pitcher's innings pitched for a given start. It is derived from recent pitch count history, organizational role context, and any active flags that override the tier entirely. Leash governs the expected IP input used in the projection formula and directly gates over eligibility.

---

## Tier definitions

### Full leash — 6.0 IP expected

**Criteria:** Pitcher has thrown 90+ pitches in at least 2 of his last 3 starts.

**What this means:** The organization is letting this pitcher work deep. The ceiling is real. The over projection is built on a legitimate IP foundation.

**Confidence block contribution:** 2/2 points in Block 2.

---

### Mod+ leash — 5.5 IP expected

**Criteria:** Pitcher has thrown 85–89 pitches in at least 2 of his last 3 starts, OR has thrown 90+ in exactly 1 of his last 3 starts with the other two at 80+.

**What this means:** Workload is consistent but the organization is managing him slightly below deep-game territory. Reliable ceiling with minor compression.

**Confidence block contribution:** 1.5/2 points in Block 2.

---

### Mod leash — 5.0 IP expected

**Criteria:** Pitcher has averaged 75–84 pitches over his last 3 starts, or pitch counts are volatile (one 95-pitch start, one 68-pitch start).

**What this means:** Inconsistent workload. The ceiling is uncertain. Over projection carries real IP variance risk.

**Confidence block contribution:** 1/2 points in Block 2.

---

### Short leash — 4.0 IP expected

**Criteria:** Pitcher has averaged fewer than 75 pitches over his last 3 starts, OR is on a defined organizational pitch limit, OR is pitching in a volatile lineup protection role.

**What this means:** The ceiling is low. The over is almost certainly priced incorrectly relative to the real IP expectation. Play the over only if the projection still clears the margin floor at 4.0 IP — which is rare.

**Confidence block contribution:** 0/2 points in Block 2. **Automatic over kill-switch.**

> A Short leash does not kill the under. A Short leash on an under is often a signal worth pursuing — the market may be pricing the line based on a longer-leash assumption.

---

## Override flags

These flags override the tier entirely and halt over evaluation before leash scoring.

### IL return flag

**Trigger:** Pitcher is returning from the injured list (any IL designation) and this is his first or second start back.

**Behavior:** Assign `leash_flag = IL_RETURN`. Do not score Block 2. Kill the over immediately. The organizational pitch limit on IL returns is typically 60–75 pitches regardless of the pitcher's historical workload.

**Under note:** An IL return can be a strong under angle if the market is pricing a full-leash line.

---

### Extended rest flag

**Trigger:** Pitcher has not started in 10 or more days (not due to an IL stint — that's the IL flag).

**Behavior:** Assign `leash_flag = EXTENDED_REST`. Do not score Block 2. Kill the over. Extended rest pitchers often face organizational pitch caps of 80–85 pitches regardless of recent history, and their command and efficiency are less predictable.

---

### Opener / bulk reliever flag

**Trigger:** Pitcher is confirmed in an opener or bulk reliever role for this game.

**Behavior:** Projection is uncalculable. Halt at Step 1. The expected IP is undefined and the K total is dependent on when the opener is pulled — which is not knowable in advance.

---

### Organizational role constraint flag

**Trigger:** Evidence (beat reporter, manager quote, known organizational policy) suggests the pitcher is being held under a hard pitch limit regardless of recent workload.

**Behavior:** Override leash tier to reflect the stated limit. If the limit maps to Short leash, apply Short leash rules. This flag must be sourced — not assumed.

---

## Distinguishing workload constraint from organizational constraint

These are different signals and require different handling.

**Workload constraint** means the pitcher has been physically managing his arm load and recent pitch counts reflect that. This is captured in the standard tier classification.

**Organizational constraint** means a decision above the pitcher is capping his usage — bullpen coverage, trade deadline positioning, service time management, or explicit load management policy. This is a harder ceiling that the pitch count data may not yet reflect.

When organizational constraint is suspected but not confirmed, do not assume it. Source it or treat it as a trap flag (see `docs/06_trap_detection.md`).

---

## Worked examples

**Example A — Full leash**
Last 3 starts: 97 pitches, 93 pitches, 88 pitches.
2 of 3 at 90+. → Full leash. Expected IP: 6.0.

**Example B — Mod+ leash**
Last 3 starts: 92 pitches, 82 pitches, 84 pitches.
1 of 3 at 90+, other two at 80+. → Mod+ leash. Expected IP: 5.5.

**Example C — Mod leash (volatile)**
Last 3 starts: 96 pitches, 68 pitches, 81 pitches.
High variance. One outlier low. → Mod leash. Expected IP: 5.0.

**Example D — Short leash**
Last 3 starts: 74 pitches, 71 pitches, 79 pitches.
Average: 74.7. Below 75 threshold. → Short leash. Over killed.

**Example E — IL return**
Pitcher returning from 15-day IL. First start back.
→ IL return flag. Block 2 not scored. Over killed regardless of pitch count history.

---

## Program interpretation

```python
def classify_leash(pitcher):
    # Override flags take priority
    if pitcher.il_return:
        return LeashResult(tier=None, flag="IL_RETURN", over_eligible=False)

    if pitcher.days_since_last_start >= 10 and not pitcher.il_return:
        return LeashResult(tier=None, flag="EXTENDED_REST", over_eligible=False)

    if pitcher.role in ["opener", "bulk_reliever"]:
        raise ProjectionUncalculable("Opener/bulk role — IP undefined")

    if pitcher.org_pitch_limit is not None:
        # Map org limit to tier
        if pitcher.org_pitch_limit < 75:
            return LeashResult(tier="Short", flag="ORG_LIMIT", over_eligible=False)
        elif pitcher.org_pitch_limit < 85:
            return LeashResult(tier="Mod", flag="ORG_LIMIT", over_eligible=True)
        else:
            pass  # fall through to standard classification

    # Standard tier classification from last 3 starts
    counts = pitcher.last_three_pitch_counts
    if len(counts) < 3:
        return LeashResult(tier="Mod", flag="SMALL_SAMPLE", over_eligible=True)

    high_count = sum(1 for c in counts if c >= 90)
    mid_count = sum(1 for c in counts if 80 <= c < 90)
    avg = sum(counts) / len(counts)

    if high_count >= 2:
        return LeashResult(tier="Full", flag=None, over_eligible=True)
    elif high_count == 1 and mid_count >= 2:
        return LeashResult(tier="Mod+", flag=None, over_eligible=True)
    elif avg >= 85:
        return LeashResult(tier="Mod+", flag=None, over_eligible=True)
    elif avg >= 75:
        return LeashResult(tier="Mod", flag=None, over_eligible=True)
    else:
        return LeashResult(tier="Short", flag=None, over_eligible=False)
```