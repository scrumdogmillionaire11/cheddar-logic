# 05 — Market tiers

## Rule

The margin between the engine's projection and the market line determines whether a play is eligible and contributes to confidence scoring. Overs and unders have asymmetric margin requirements. Thin edges are discarded. Vig differentials are noted when they affect true EV.

---

## Why unders require larger margins

Books build a structural over-bias into strikeout prop pricing. The public leans over on star pitchers, so books shorten over juice and lengthen under juice relative to true probability. This means the under is systematically undervalued at face value — and it also means you need a larger margin on the under to confirm that the edge is real and not just a function of the pricing structure.

Betting the under into a tight margin means fighting both the book's pricing and the market's design simultaneously.

---

## Margin floor (minimum to continue evaluation)

| Side | Minimum margin | Action if below floor |
|------|---------------|----------------------|
| Over | 0.5 Ks | Block 1 = 0. Halt. No play. |
| Under | 0.75 Ks | Block 1 = 0. Halt. No play. |

Margin is calculated as: `projection − line` for overs, `line − projection` for unders.

**Example (over):** Projection 7.8, line 7.5 → margin +0.3 → below floor → halt.
**Example (under):** Projection 6.1, line 7.0 → margin +0.9 → above floor → continue.

---

## Block 1 scoring tiers

### Over tiers

| Margin | Block 1 score |
|--------|--------------|
| Below 0.5K | 0 — halt |
| 0.5–0.74K | 1 pt |
| 0.75–1.0K | 2 pts |
| Above 1.0K | 3 pts |

### Under tiers

| Margin | Block 1 score |
|--------|--------------|
| Below 0.75K | 0 — halt |
| 0.75–1.0K | 1 pt |
| 1.0–1.5K | 2 pts |
| Above 1.5K | 3 pts |

---

## Market structure check (Block 4)

After margin is established, evaluate the direction and character of market movement since opening.

### Block 4 scoring

**1 pt — Stable or favorable movement:**
- Line has not moved since open, OR
- Line moved in the direction of your play (e.g., over line moved up from 7.0 to 7.5, you're still playing over), OR
- Minor movement (≤0.5 on the line) with no evidence of sharp counter-action

**0 pts — Unfavorable or suspect movement:**
- Line moved against your play after open (e.g., over line moved from 7.5 to 7.0, you're playing over at 7.0)
- Significant counter-movement suggesting sharp money on the other side
- Line compressed to make your margin thinner than when evaluated

### What market movement is not

Market movement in prop markets is not a CLV signal. Prop markets are illiquid — sharp money moves lines disproportionately, and a line move does not reliably indicate that the market has corrected toward true probability the way game markets do.

Block 4 is a directional sanity check only. It is capped at 1 point because it does not deserve more weight than that in an illiquid market.

---

## Line shopping protocol

When evaluating the margin, use the best available line for the play direction — not the consensus or the first line found.

| Side | Line shopping principle |
|------|------------------------|
| Over | Find the lowest over line available (most favorable) |
| Under | Find the highest under line available (most favorable) |

If the best line for the play results in a margin above the floor, and the consensus line does not, you have a line-shopping edge. Note the best line and the book offering it in the output.

**Example:** Consensus over line is 7.5. One book offers 7.0 on the over. Projection is 7.6. Margin at consensus = 0.1K (below floor, no play). Margin at best line = 0.6K (above floor, 1-pt play). The line shop creates the edge.

---

## Vig consideration

Vig does not affect the margin calculation but does affect true EV and should be noted in the output.

**Vig adjustment rule:** If the over juice exceeds -130 (you are paying more than 30 cents of vig), flag it in the output. The margin must be larger to compensate for the juice cost.

| Juice | Breakeven win rate |
|-------|--------------------|
| -110 | 52.4% |
| -115 | 53.5% |
| -120 | 54.5% |
| -125 | 55.6% |
| -130 | 56.5% |
| -140 | 58.3% |

At -140 juice on an over, you need to hit the bet 58.3% of the time to break even. A 1-pt margin play at -140 is not a strong play. A 3-pt margin play at -140 may still be viable depending on projected hit rate.

**Engine flag:** If juice > -130, add `[HIGH VIG]` tag to the output. This does not kill the play but must be visible.

---

## Alt line protocol

When the standard line has insufficient margin, evaluate alt lines before dismissing the play.

**Alt line rules:**
- Alt lines are valid evaluation targets if they are available at -130 or better juice
- Calculate margin against the alt line
- If the alt line margin clears the floor, the play is evaluated at the alt line
- Note the alt line and book in the output

**Example:** Standard line o7.5 at -115. Projection 7.9. Margin = 0.4K (below floor at standard line). Alt line o7.0 available at -125. Margin = 0.9K (above floor). Evaluate at o7.0 -125 alt. Note juice is elevated but not at the -130 flag threshold.

---

## Margin calculation cheat sheet

```
Over margin  = projection − over_line
Under margin = under_line − projection

Over floor   = 0.5
Under floor  = 0.75

Block 1 over  tiers: [0→halt] [0.5→1pt] [0.75→2pt] [1.0→3pt]
Block 1 under tiers: [0→halt] [0.75→1pt] [1.0→2pt] [1.5→3pt]
```

---

## Program interpretation

```python
def score_market(projection, line, side, opening_line, current_juice):
    # Calculate margin
    if side == "over":
        margin = projection - line
        floor = 0.5
        tiers = [(1.0, 3), (0.75, 2), (0.5, 1), (0, 0)]
    else:  # under
        margin = line - projection
        floor = 0.75
        tiers = [(1.5, 3), (1.0, 2), (0.75, 1), (0, 0)]

    # Gate check
    if margin < floor:
        return MarketResult(block1_score=0, halt=True, reason=f"Margin {margin:.2f}K below {floor}K floor")

    # Block 1 score
    block1 = next(pts for threshold, pts in tiers if margin >= threshold)

    # Block 4 — market movement direction
    if side == "over":
        line_moved_against = current_line > opening_line  # over went up = worse for over
    else:
        line_moved_against = current_line < opening_line  # under went down = worse for under

    block4 = 0 if line_moved_against else 1

    # Vig flag
    high_vig = current_juice < -130  # e.g., -135 is < -130

    return MarketResult(
        block1_score=block1,
        block4_score=block4,
        margin=margin,
        halt=False,
        high_vig=high_vig
    )
```