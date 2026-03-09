# FPL Sage Output Glossary - Quick Reference

## Primary Actions

| Code | Display | Emoji | Meaning |
|------|---------|-------|---------|
| TRANSFER | Make Transfer(s) | 🔄 | Make the recommended transfer(s) to improve your squad for upcoming gameweeks |
| ROLL | Roll Transfer | 💰 | Save your free transfer for next gameweek - no moves offer enough value right now |
| CHIP | Activate Chip | 🎯 | Use your chip this gameweek for maximum strategic advantage |

## Confidence Levels

| Level | Display | Emoji | Meaning |
|-------|---------|-------|---------|
| HIGH | High Confidence | ✅ | Strong data support with clear value proposition |
| MED | Medium Confidence | ⚖️ | Reasonable recommendation but some uncertainty in fixtures or form |
| LOW | Low Confidence | ⚠️ | Weak signals - consider waiting for more information or alternative options |

## Chip Types

| Code | Display | Emoji | What It Does |
|------|---------|-------|--------------|
| WC | Wildcard | 🃏 | Rebuild your entire squad with unlimited free transfers for one gameweek |
| BB | Bench Boost | 📈 | Your bench players score points this gameweek - maximize when all 15 have good fixtures |
| TC | Triple Captain | 👑 | Your captain scores triple points instead of double - use on explosive fixtures |
| FH | Free Hit | 🎪 | Make unlimited transfers for one gameweek only, then your squad reverts back |
| NONE | No Chip | 🔒 | Better opportunities ahead - keep your chips for more valuable gameweeks |

## Risk Postures

| Level | Display | Emoji | Strategy |
|-------|---------|-------|----------|
| conservative | Conservative | 🛡️ | Minimize risks, avoid point hits, choose popular safe captains |
| balanced | Balanced | ⚖️ | Take calculated risks when value is clear, standard FPL strategy |
| aggressive | Aggressive | 🎲 | Take risks for rank improvement, consider differential captains and punts |

## Strategy Modes (Auto-Selected)

| Mode | Trigger (Rank Bucket Default) | Behavior |
|------|-------------------------------|----------|
| DEFEND | `<= 50k` | Protect floor, favor high-ownership/template picks, stricter transfer bar |
| CONTROLLED | `50,001-500k` | Stable upgrades with moderate variance |
| BALANCED | `500,001-3M` | Standard EV posture with normal thresholding |
| RECOVERY | `> 3M` | Lower transfer thresholds, higher leverage/differential tolerance |

Risk posture then nudges this mode one step safer (`conservative`) or riskier (`aggressive`) when possible.

## Rank Bucket Ladder

| Bucket | Overall Rank |
|--------|--------------|
| elite | `<= 50,000` |
| strong | `50,001-500,000` |
| mid | `500,001-3,000,000` |
| recovery | `> 3,000,000` |

## Transfer Metrics Explained

| Metric | What It Means |
|--------|---------------|
| **Hit Cost** | Points deducted this gameweek (-4 per extra transfer beyond free transfers) |
| **Free** | Transfer is within your free transfer allowance (no points deducted) |
| **Net £** | How your bank changes after the transfer (positive = more money, negative = less money) |
| **Δ pts (4 GW)** | Expected total point gain over the next 4 gameweeks |
| **Δ pts (6 GW)** | Expected total point gain over the next 6 gameweeks |

## New Transparency Fields (API/UI)

| Field | Meaning |
|-------|---------|
| `strategy_mode` | Active rank-aware mode used to score and gate moves |
| `manager_state` | Rank/posture/mode context (`overall_rank`, `risk_posture`, `strategy_mode`, `rank_bucket`, `free_transfers`) |
| `near_threshold_moves` | Moves that almost passed thresholds with explicit rejection reasons |
| `strategy_paths` | Safe/Balanced/Aggressive alternatives for override decisions |
| `squad_issues` | Structural diagnostics (lineup weakness, bench risk, availability flags) |
| `chip_timing_outlook` | Suggested future windows for BB/TC/FH with rationale |
| `fixture_planner` | 8-GW DGW/BGW timeline plus squad/target windows and deterministic planning notes |
| `transfer_plans.no_transfer_reason` | Threshold-aware explanation when no move is recommended |

## DGW/BGW Planner Fields

`fixture_planner` is additive and optional on `/analyze/{id}/projections`.

| Field | Meaning |
|-------|---------|
| `horizon_gws` | Fixed planning horizon (`8`) |
| `start_gw` | Start gameweek (`next_gameweek` fallback `current_gw`) |
| `gw_timeline[]` | Per-GW DGW/BGW team lists and total fixtures |
| `squad_windows[]` | Current squad 8-GW windows with DGW/BGW summary and weighted fixture score |
| `target_windows[]` | Prioritized transfer targets with the same window shape |
| `key_planning_notes[]` | Deterministic trigger notes (blank pressure, DGW clusters, adjacency caution, etc.) |

## Captain Roles

| Role | Display | Meaning |
|------|---------|---------|
| Captain | Captain (2x points) | Your captain scores double points this gameweek |
| Vice Captain | Vice Captain (backup) | Only gets double points if your captain doesn't play |

## Transfer Actions

| Symbol | Meaning |
|--------|---------|
| ➖ Player Out | The player you're transferring out of your squad |
| ➕ Player In | The player you're bringing into your squad |
| → | Transfer direction (Out → In) |

## Common Questions

**Q: What does "ROLL" mean?**
A: Save your free transfer(s) for next gameweek. You'll have 2 free transfers next week instead of just 1.

**Q: What's a "hit"?**
A: Making a transfer beyond your free transfers costs -4 points per extra transfer. This is called "taking a hit."

**Q: When should I take a hit?**
A: Only when the expected point gain (Δ pts) significantly exceeds the hit cost over 4-6 gameweeks.

**Q: What does "Net £" mean?**
A: The change to your remaining budget. Positive means you're banking money, negative means you're spending from your bank.

**Q: Why does it say "No Chip"?**
A: The algorithm has identified that saving your chip for a future gameweek will provide more value. Better opportunities are coming.

**Q: What's the difference between captain and vice captain?**
A: Captain gets 2x points. Vice captain is a backup - only gets 2x points if your captain doesn't play at all.

## Visual Guide

### Decision Brief Layout
```
[EMOJI] [ACTION NAME]
        [Detailed explanation of what this action means]

[EMOJI] [CONFIDENCE LEVEL]
        [What this confidence level tells you]

[Justification explaining why this recommendation was made]
```

### Chip Decision Layout
```
[CHIP EMOJI] [CHIP FULL NAME]
             [What this chip does in plain English]
             
             [Strategic reasoning for this gameweek]
             
             Available chips: [List of remaining chips]
```

### Transfer Layout
```
[Player Out Name] → [Player In Name]

Hit Cost: Free (or -4pts, -8pts, etc.)
          [Explanation: "Within free transfers" or "Points deducted this GW"]

Net £: +1.2m
       [Explanation: "Bank increases"]

Δ pts (4 GW): +8.5
              [Explanation: "Expected gain over 4 gameweeks"]
```
