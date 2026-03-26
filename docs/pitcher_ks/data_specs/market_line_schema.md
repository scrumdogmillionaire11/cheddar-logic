# Market line schema

## Purpose

Defines the market line input object used for margin calculation (Block 1), market structure scoring (Block 4), vig flagging, and line shopping.

---

## Schema

```json
{
  "market": {
    "side": "string — 'over' or 'under'",
    "line": "float — the line being evaluated (e.g., 7.5)",
    "juice": "integer — American odds on the evaluated side (e.g., -115)",
    "book": "string — book name where this line was found",

    "opening_line": "float — line at market open",
    "opening_juice": "integer — juice at market open",
    "opening_book": "string — book where opening line was sourced",
    "opening_timestamp": "string — ISO timestamp",

    "best_available_line": "float — best line for play direction across all books",
    "best_available_juice": "integer — juice at best available line",
    "best_available_book": "string — book offering best available line",

    "current_timestamp": "string — ISO timestamp of line retrieval",

    "alt_lines": [
      {
        "line": "float",
        "juice": "integer",
        "book": "string",
        "side": "string"
      }
    ],

    "movement_notes": "string — optional narrative on any significant movement",
    "sharp_book_action": "string — 'for_play' | 'against_play' | 'none' | 'unknown'",
    "line_source": "string — primary odds aggregator used (e.g., OddsJam, Unabated)"
  }
}
```

---

## Field rules

| Field | Required | Halt if missing |
|-------|----------|----------------|
| `side` | Yes | Yes |
| `line` | Yes | Yes — margin cannot be calculated |
| `juice` | Yes | Yes |
| `book` | Yes | No — log only |
| `opening_line` | Recommended | Block 4 defaults to 0 if missing |
| `best_available_line` | Recommended | Use `line` for margin calc if missing |
| `current_timestamp` | Yes | No — log only, but staleness check fails |
| `alt_lines` | No | Optional |
| `sharp_book_action` | Recommended | Block 4 limited if missing |

---

## Line freshness requirement

Lines must be retrieved within 30 minutes of play submission. If `current_timestamp` is more than 30 minutes before play time, re-pull the line before finalizing.

---

## Movement direction logic

```python
def assess_movement(opening_line, current_line, side):
    if side == "over":
        # Over line going up = worse for over bettor (fewer Ks needed to hit)
        # Wait — over going from 7.0 to 7.5 = worse for over
        moved_against = current_line > opening_line
    else:
        # Under line going down = worse for under bettor
        moved_against = current_line < opening_line

    if abs(current_line - opening_line) < 0.25:
        return "STABLE"
    elif moved_against:
        return "AGAINST_PLAY"
    else:
        return "FAVORABLE"
```

---

## Vig calculation

```python
def american_to_implied_prob(american_odds):
    if american_odds < 0:
        return abs(american_odds) / (abs(american_odds) + 100)
    else:
        return 100 / (american_odds + 100)

def breakeven_rate(juice):
    return american_to_implied_prob(juice)
```

---

## Example — valid market input

```json
{
  "market": {
    "side": "over",
    "line": 7.5,
    "juice": -115,
    "book": "DraftKings",

    "opening_line": 7.5,
    "opening_juice": -110,
    "opening_book": "Pinnacle",
    "opening_timestamp": "2026-04-15T10:30:00Z",

    "best_available_line": 7.0,
    "best_available_juice": -125,
    "best_available_book": "FanDuel",

    "current_timestamp": "2026-04-15T17:45:00Z",

    "alt_lines": [
      {"line": 7.0, "juice": -125, "book": "FanDuel", "side": "over"},
      {"line": 8.0, "juice": 105, "book": "DraftKings", "side": "over"}
    ],

    "movement_notes": "Line held at 7.5 since open. Juice tightened from -110 to -115.",
    "sharp_book_action": "none",
    "line_source": "OddsJam"
  }
}
```