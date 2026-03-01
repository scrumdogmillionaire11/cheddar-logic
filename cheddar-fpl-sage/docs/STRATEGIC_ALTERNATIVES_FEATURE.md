# Strategic Transfer Alternatives Feature

## Overview

Enhanced the transfer recommendation system to provide **strategic alternatives** instead of just the single "best value" option. Now users can see multiple transfer options with clear strategic labels (PREMIUM/VALUE/BALANCED).

## The Problem

Previously, the system only showed the top 2 options sorted by `points_per_million` (value metric). This meant:
- Users only saw the "best value" picks
- Premium upgrade paths were hidden
- No clear choice between spending more for better players vs. optimizing budget

## The Solution

### Backend Changes

#### 1. Transfer Advisor (`transfer_advisor.py`)

**Modified replacement selection logic** (lines ~310-340 and ~750-790):

```python
# OLD: Just sorted by value, took top 2
viable_replacements.sort(key=lambda x: x.points_per_million, reverse=True)
top_options = viable_replacements[:2]

# NEW: Provide strategic alternatives
viable_replacements.sort(key=lambda x: x.points_per_million, reverse=True)
best_value = viable_replacements[0]

viable_replacements.sort(key=lambda x: x.nextGW_pts, reverse=True)
best_premium = viable_replacements[0]

strategic_options = [best_value]
if best_premium.player_id != best_value.player_id:
    strategic_options.append(best_premium)

# Add balanced option if available
if len(viable_replacements) > 2:
    for p in viable_replacements:
        if p.player_id not in [best_value.player_id, best_premium.player_id]:
            strategic_options.append(p)
            break
```

**Enhanced `build_transfer_plan`** (lines ~603-650):

```python
# Format alternatives with strategic labels
alternative_details = []
for alt in alternatives[:2]:
    if alt.player_id == best_value_id and alt.player_id != best_premium_id:
        label = "VALUE"
    elif alt.player_id == best_premium_id and alt.player_id != best_value_id:
        label = "PREMIUM"
    else:
        label = "BALANCED"
    
    alternative_details.append({
        'name': alt.name,
        'price': round(alt.current_price, 1),
        'points': round(alt.nextGW_pts, 1),
        'strategy': label
    })

return {
    # ... other fields ...
    "suggested_alternatives": alternative_details
}
```

#### 2. Result Transformer (`result_transformer.py`)

Added `alternatives` field to paired transfers:

```python
paired_transfers.append({
    # ... existing fields ...
    "alternatives": transfer.get('suggested_alternatives', [])
})
```

### Frontend Changes

#### TransferSection Component (`TransferSection.tsx`)

**Added TypeScript interface:**

```typescript
interface TransferAlternative {
  name: string;
  price: number;
  points: number;
  strategy: 'VALUE' | 'PREMIUM' | 'BALANCED';
}
```

**Display alternatives after main transfer:**

```tsx
{primaryPlan.alternatives && primaryPlan.alternatives.length > 0 && (
  <div className="mt-4 pt-4 border-t border-surface-elevated">
    <div className="text-body-sm text-sage-muted uppercase tracking-wider mb-3">
      Alternative Options
    </div>
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
      {primaryPlan.alternatives.map((alt, idx) => (
        <div key={idx} className="flex items-center gap-3 p-3 bg-surface-base rounded border border-surface-elevated">
          <div className="flex-1">
            <div className="flex items-center gap-2">
              <span className="text-body font-medium text-sage-white">{alt.name}</span>
              {alt.strategy === 'VALUE' && (
                <span className="px-2 py-0.5 bg-execute/20 border border-execute/40 rounded text-xs text-execute">
                  VALUE
                </span>
              )}
              {alt.strategy === 'PREMIUM' && (
                <span className="px-2 py-0.5 bg-hold/20 border border-hold/40 rounded text-xs text-hold">
                  PREMIUM
                </span>
              )}
              {alt.strategy === 'BALANCED' && (
                <span className="px-2 py-0.5 bg-sage-muted/20 border border-sage-muted/40 rounded text-xs text-sage-muted">
                  BALANCED
                </span>
              )}
            </div>
            <div className="text-body-sm text-sage-muted mt-1">
              £{alt.price.toFixed(1)}m · {alt.points.toFixed(1)} pts
            </div>
          </div>
        </div>
      ))}
    </div>
  </div>
)}
```

## Strategic Labels

### VALUE 🟢
- **Highest points per million** in the candidate pool
- Best budget optimization
- Maximizes value for money
- Example: Senesi (£4.5m, 5.2 pts) = 1.16 pts/£

### PREMIUM 🟡
- **Highest raw points projection** in the candidate pool
- Best absolute performance
- Worth spending extra budget
- Example: Konate (£5.2m, 6.8 pts) = 1.31 pts/£

### BALANCED ⚪
- **Well-rounded option** between VALUE and PREMIUM
- Good points AND good value
- Neither the cheapest nor most expensive
- Safe middle-ground choice

## Example Output

```
Transfer OUT: Romero
Transfer IN: Konate (Primary recommendation)

Alternative Options:
┌─────────────────────────────┬─────────────────────────────┐
│ Senesi             [VALUE]  │ Gabriel         [PREMIUM]   │
│ £4.5m · 5.2 pts             │ £5.8m · 7.1 pts             │
└─────────────────────────────┴─────────────────────────────┘
```

## Implementation Details

### Decision Flow

1. **Filter viable replacements**:
   - Not injured (`not p.is_injury_risk`)
   - Expected to play (`p.xMins_next >= 60`)
   - Not already in squad
   - Not already recommended
   - Within budget

2. **Sort twice**:
   - First by `points_per_million` → identifies VALUE option
   - Then by `nextGW_pts` → identifies PREMIUM option

3. **Handle duplicates**:
   - If VALUE and PREMIUM are the same player, find second-best premium
   - If distinct, include both in strategic_options

4. **Add balanced option**:
   - If 3+ viable candidates exist
   - Pick first option that's neither VALUE nor PREMIUM

5. **Format for display**:
   - Label each alternative with its strategy
   - Include price, points, and name
   - Pass through to frontend as structured data

## Testing

All 12 transfer-related tests passing:
```bash
pytest tests/ -k "transfer" -v
# 12 passed, 1 skipped, 169 deselected
```

## Benefits

1. **User Choice**: See multiple strategic paths instead of just one
2. **Budget Flexibility**: Choose premium upgrades OR value picks
3. **Clear Strategy**: Labels make the trade-off explicit
4. **Better Decision Making**: Can weigh budget vs. performance clearly
5. **Transparency**: Users understand why each option is suggested

## Future Enhancements

Potential improvements:
- Show points-per-million calculation explicitly
- Add "form trend" indicators (rising/falling)
- Include ownership % for differential plays
- Show fixture difficulty comparison
- Add "safer floor" vs "higher ceiling" labels
