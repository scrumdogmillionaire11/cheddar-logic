# ✅ FPL SAGE ENHANCEMENT TODO LIST

*(User Experience, Correctness, and Decision Value)*

---

## A. 🔴 CRITICAL CORRECTNESS FIXES (Must be done first)

These are **bugs or contract violations**. Until these are fixed, UX polish is irrelevant.

### A1. Risk Posture Single Source of Truth

* [ ] Ensure `risk_posture` exists in **one place only**
* [ ] Runtime value passed into:

  * Decision framework
  * Chip analyzer
  * Transfer advisor
* [ ] Summary **must reflect runtime value**
* [ ] If mismatch detected → **block analysis with error**

---

### A2. Season Resolution (Ruleset Load Failure)

* [ ] Always resolve `season` explicitly (e.g. `2025-26`)
* [ ] Never allow `season = unknown`
* [ ] If season missing:

  * Print `DATA_GAP: SEASON_MISSING`
  * Do not silently fall back to default ruleset
* [ ] Log which ruleset was loaded

---

### A3. Manual Transfer Validation (No Ghost Transfers)

* [ ] Do not allow creation of transfers with:

  * `None`
  * `Unknown`
  * `? → ?`
* [ ] Enforce required fields:

  * `out_player_id`
  * `in_player_id`
* [ ] If user exits without adding transfers:

  * Save `planned_transfers: []`
* [ ] Never persist placeholder transfers to config

---

### A4. Chip Status Clarity

* [ ] Separate:

  * **Available chips**
  * **Active this GW**
* [ ] Never show all chips as “✅” without context
* [ ] If a chip is active:

  * Disable chip recommendations
  * Run chip-specific logic only

---

### A5. GW Lineup Resolution Messaging

* [ ] Replace noisy 404 logs with one clear message:

  * `Lineup source: GW23 (GW24 picks not published yet)`
* [ ] Store:

  * `current_gameweek`
  * `next_gameweek`
  * `lineup_source`
* [ ] Show this once in user output

---

## B. 🟠 CLI UX & INTERACTION FIXES

These reduce confusion and cognitive load.

### B1. Logging Hygiene

* [ ] Default mode: **NO raw INFO logs**
* [ ] Add `--verbose` flag to show:

  * API fetches
  * Debug traces
* [ ] Group logs by phase when verbose is on

---

### B2. Manual Transfer UX Improvements

* [ ] On name entry:

  * Show top 5 matches (name, team, price, ID)
* [ ] Require explicit user selection if ambiguous
* [ ] Add “Test name matching” as a *real* validation step
* [ ] Block “Review & save” if transfers are invalid* [ ] Add inline help hints:
  * "💡 Tip: Type just the last name - we'll find matches"
* [ ] Show confirmation before saving high-impact transfers:
  * "This will take a -4 hit. Continue? (y/n)"
---

### B3. Clear Phase Separation in Output

Add visible headers:

* [ ] INPUTS & OVERRIDES
* [ ] DATA HEALTH
* [ ] DECISION OUTPUT
* [ ] FILES WRITTEN

---

### B4. Error Messages & User Guidance (UX)

* [ ] Replace technical errors with **friendly messages + next steps**:
  * ❌ Bad: `DATA_GAP: SEASON_MISSING`
  * ✅ Good: "We couldn't detect your season. Run: `fpl-sage --season 2025-26`"
* [ ] All error messages must include:
  * What went wrong (plain English)
  * Why it matters
  * Exact command to fix it
* [ ] Add **"Why am I seeing this?"** explanations for warnings
* [ ] Replace technical terminology with user-friendly language:
  * "Risk posture" → "Your playing style" (Cautious/Balanced/Aggressive)
  * "GW lineup resolution" → "Using your GW23 team (GW24 not available yet)"
  * "Hit threshold" → "Points break-even calculation"

---

### B5. Deadline & Timing Awareness (UX)

* [ ] Add **deadline reminder** prominently in output:
  * "⏰ Deadline: Friday 6:30 PM (2 days, 14 hours)"
* [ ] Show **optimal timing** hints:
  * "💭 Best time to decide: Friday 5 PM (after press conferences)"
* [ ] Include in success confirmations:
  * "✅ Transfer saved! Make this move by Friday 6:30 PM"

---

## C. 🟡 DECISION QUALITY & VALUE (Core product value)

This is where it becomes **worth using**.

### C1. Enforce a “MoveCard” Contract

Every run must output:

* [ ] Primary action (transfer / roll)
* [ ] Secondary action (if any)
* [ ] Captain + vice
* [ ] Chip instruction
* [ ] Hit recommendation
* [ ] Risk note

If any are missing → analysis fails.

---

### C2. Captaincy Explanation (Non-Optional)

For captain:

* [ ] Minutes assumption
* [ ] Fixture quality
* [ ] Role security
* [ ] Projection delta vs next best

Also show:

* [ ] At least 2 **passed-on** candidates with reasons

---

### C3. Transfer Explanation (Even When NONE)

If no transfer:

* [ ] Explain why best candidate failed:

  * Projection delta too small
  * Hit threshold failed
  * Bank flexibility preserved
* [ ] Show what WOULD trigger a move

---

### C4. Chip Decision Gates (Explicit)

Replace vague text with:

* [ ] Named gates (DGW, captain outlier, injury spike)
* [ ] Numeric thresholds where possible
* [ ] “What would unlock a chip next GW”

---

### C5. Avoid List

* [ ] Always show top 3–5 players to avoid
* [ ] Reason tags:

  * Rotation risk
  * Fixture downturn
  * Minutes risk
  * Overpriced

---

## D. 🟢 SUMMARY OUTPUT (What the user actually reads)

This is the **highest-leverage section**.

### D1. Replace Vague Language

* [ ] Ban phrases like:

  * “favors a later window”
  * “once risk gates are satisfied”
* [ ] Every sentence must be falsifiable
* [ ] Use **visual indicators** for decision clarity:
  * ✅ PROCEED / ⚠️ CAUTION / 🛑 STOP for transfer decisions
  * 💰 for financial impact (price changes, bank management)
  * 📊 for data quality indicators
* [ ] Consider adding **confidence score** display:
  * "Confidence: 85%" for recommendations

---

### D2. Summary Must Answer 5 Questions

Ensure summary explicitly answers:

* [ ] What should I do?
* [ ] Why?
* [ ] What was rejected?
* [ ] What would change this?
* [ ] What should I watch next GW?
* [ ] When no transfers recommended, show **opportunity cost**:
  * "By rolling your transfer, you'll have 2FT next week for [trending player]"

---

### D3. One-Line Verdict

* [ ] End with a decisive, human sentence:

  * “Roll the transfer. Captain X. Reassess chips in GW26.”

---
### D4. Progressive Disclosure (UX)

* [ ] **Summary-first, details-on-demand** approach:
  * Show the one-line verdict FIRST at the top
  * Then offer: "View detailed reasoning? (y/n)"
  * Keeps casual users fast, power users informed
* [ ] Add collapsible sections in verbose mode:
  * "[+] Expand captaincy alternatives"
  * "[+] Show rejected transfer options"
* [ ] Success confirmations with actionable next step:
  * "✅ Decision saved! Next: Make your transfers in the FPL app"

---
## E. 🧪 TESTING & SAFETY RAILS

### E1. Golden Snapshot Test

* [ ] Store a known “good” summary output
* [ ] CI fails if summary regresses or drops required sections

---

### E2. Data Gap Kill Switches

* [ ] Missing season → stop
* [ ] Missing fixtures → stop
* [ ] Missing projections → stop
* [ ] Ambiguous transfers → stop

No silent fallbacks.

---

## F. 📁 ARTIFACT & FILE OUTPUT CLARITY

### F1. Artifact Visibility

* [ ] Explicitly list:

  * decision.json
  * summary.md
  * data_collections file
* [ ] Include run_id and timestamp

---

## G. 🎨 UX POLISH & ACCESSIBILITY (Lower priority, high impact)

These enhance the experience once core functionality is solid.

### G1. Visual Hierarchy & Terminal Experience

* [ ] **Color-code severity** in terminal output:
  * Red = critical/blocking issues
  * Yellow = warnings/caution
  * Green = success/good to go
* [ ] Add plain text fallback if emojis don't render
* [ ] Consider `--simple` flag for minimal formatting (useful for piping/parsing)

---

### G2. Accessibility

* [ ] Ensure terminal output works well with **screen readers**
* [ ] Test with common terminal themes (light/dark)
* [ ] Avoid relying solely on color to convey meaning

---

### G3. First-Run Experience

* [ ] Add **first-run tutorial mode** explaining key concepts:
  * "Welcome to FPL Sage! This tool analyzes your team and suggests decisions."
  * Offer quick tour of main features
* [ ] Create `--help-concepts` flag explaining FPL Sage terminology
* [ ] Consider interactive setup wizard for initial config

---

### G4. Empty States & No-Decision Scenarios

* [ ] When no transfers recommended, make it **feel like a positive**:
  * "✨ Your team is solid. Bank the transfer for flexibility."
* [ ] When data is incomplete, show **what's available vs what's missing**:
  * "📊 Data available: Fixtures, Prices | Missing: Injury updates"

---

## Final blunt truth

Right now:

* The **engine is doing real work**
* The **user output is underselling it**
* The **state handling has real bugs**

This TODO list fixes all three.

If you want next, I can:

* Convert this into a **GitHub issue breakdown**
* Or a **“Definition of Done” checklist for the AI agent**
* Or a **priority-ordered execution plan (Day 1 / Day 2 / Day 3)**

But this list?
This is the full map.
