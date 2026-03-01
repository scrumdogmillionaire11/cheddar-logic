# 🎯 CLI-Style Chip Setup Demo

## Live Demo URL
**Frontend:** http://localhost:5174  
**Backend:** http://localhost:8000

## User Journey

### Before (Simple Flow)
```
Landing Page → Run Analysis → Wait → Results
```

### After (CLI-Mimicking Flow)
```
Landing Page 
  ↓
Step 1: Enter Team ID (711511)
  ↓
Step 2: Configure Chips ← NEW!
  - Select: Wildcard ✓
  - Select: Free Hit ✗
  - Select: Bench Boost ✓
  - Select: Triple Captain ✗
  ↓
Run Analysis with Chip Config → Wait → Results
```

## Visual Flow

### Screen 1: Team ID Entry
```
┌─────────────────────────────────────┐
│ FPL Sage                            │
│ Decision Console                    │
├─────────────────────────────────────┤
│                                     │
│ TEAM ID                             │
│ ┌─────────────────────────────────┐ │
│ │ 711511                          │ │
│ └─────────────────────────────────┘ │
│ fantasy.premierleague.com/entry/    │
│                                     │
│ ┌─────────────────────────────────┐ │
│ │ CONTINUE TO CHIP SETUP          │ │
│ └─────────────────────────────────┘ │
│                                     │
└─────────────────────────────────────┘
```

### Screen 2: Chip Configuration (NEW!)
```
┌─────────────────────────────────────┐
│ ← Back to Team ID | Step 2 of 2    │
├─────────────────────────────────────┤
│ Chip Status Setup                   │
│ Select chips you still have         │
│                                     │
│ ┌─────────────────────────────────┐ │
│ │ Wildcard                     ✓  │ │
│ │ Replace entire team without hits│ │
│ └─────────────────────────────────┘ │
│                                     │
│ ┌─────────────────────────────────┐ │
│ │ Free Hit                        │ │
│ │ Temporary team for one gameweek │ │
│ └─────────────────────────────────┘ │
│                                     │
│ ┌─────────────────────────────────┐ │
│ │ Bench Boost                  ✓  │ │
│ │ All 15 players score points     │ │
│ └─────────────────────────────────┘ │
│                                     │
│ ┌─────────────────────────────────┐ │
│ │ Triple Captain                  │ │
│ │ Captain scores triple points    │ │
│ └─────────────────────────────────┘ │
│                                     │
│ Selected (2): Wildcard, Bench Boost│
│                                     │
│ ┌─────────────────────────────────┐ │
│ │ CONTINUE WITH 2 CHIPS           │ │
│ └─────────────────────────────────┘ │
│                                     │
│ ┌─────────────────────────────────┐ │
│ │ SKIP SETUP (USE API DATA)       │ │
│ └─────────────────────────────────┘ │
│                                     │
└─────────────────────────────────────┘
```

## CLI Comparison

### Original CLI Experience
```bash
$ python scripts/run_analysis.py

🎯 CHIP STATUS SETUP
==========================================
Which chips do you still have available?

1. Wildcard - Replace entire team without point hits
2. Free Hit - Temporary team for one gameweek only
3. Bench Boost - All 15 players score points this gameweek
4. Triple Captain - Captain scores triple points instead of double

📝 Enter numbers (e.g., 1,3,4): 1,3

✅ CHIP STATUS CONFIGURED
---------------------------
🎯 Available: Wildcard, Bench Boost
❌ Used: Free Hit, Triple Captain

💾 Manual chip status saved to team_config.json
```

### New Web UI Experience
- ✅ Same 4 chips
- ✅ Same descriptions
- ✅ Visual selection (better UX)
- ✅ Summary of selections
- ✅ Skip option
- ✅ Sends to backend API

## API Request Example

### With Chip Overrides
```json
POST /api/v1/analyze
{
  "team_id": 711511,
  "available_chips": ["wildcard", "bench_boost"]
}
```

### Without Overrides (Original)
```json
POST /api/v1/analyze
{
  "team_id": 711511
}
```

## Testing Steps

1. **Open Frontend**
   ```bash
   open http://localhost:5174
   ```

2. **Enter Team ID**
   - Default: 711511 (pre-filled)
   - Click "CONTINUE TO CHIP SETUP"

3. **Configure Chips**
   - Select: Wildcard ✓
   - Select: Bench Boost ✓
   - Leave others unchecked
   - See summary: "Selected (2): Wildcard, Bench Boost"
   - Click "CONTINUE WITH 2 CHIPS"

4. **Watch Analysis Run**
   - Should skip cache (because overrides provided)
   - Should create new analysis job
   - Navigate to progress page

5. **Alternative: Skip Setup**
   - Click "SKIP SETUP (USE API DATA)"
   - Will use API chip data (less reliable)
   - May use cache if available

## Developer Notes

### State Flow
```typescript
step: 'team-id' | 'chip-setup'

// Step 1
teamId: '711511' → validates → setStep('chip-setup')

// Step 2
chips: { wildcard: true, benchBoost: true, ... }
      → converts to API format
      → sends to backend
      → navigates to /analyze/:id
```

### Chip Name Conversion
```typescript
Frontend (camelCase) → API (snake_case)
{
  wildcard: true        → "wildcard"
  freeHit: false        → (not sent)
  benchBoost: true      → "bench_boost"
  tripleCaptain: false  → (not sent)
}

// Result: ["wildcard", "bench_boost"]
```

### Cache Behavior
```python
# Backend logic
if request.available_chips:
    # Manual overrides: skip cache, run fresh
    overrides = {"available_chips": request.available_chips}
    job = create_analysis(team_id, gameweek, overrides)
else:
    # No overrides: check cache first
    cached = get_cached_analysis(team_id, gameweek)
    if cached:
        return cached
```

## Success Metrics

- ✅ **User Experience**: CLI flow replicated in web UI
- ✅ **Type Safety**: Full TypeScript coverage
- ✅ **API Integration**: Backend accepts and stores overrides
- ✅ **Build Success**: No errors, production-ready
- ⏳ **Engine Integration**: TODO (wiring to analysis)

## Next Session Tasks

1. **Wire Overrides to Engine**
   - Modify `FPLSageIntegration.run_full_analysis()`
   - Accept `overrides` parameter
   - Apply to chip status manager
   - ~30 minutes

2. **Add Manual Transfers** (Future)
   - Similar flow: Step 3
   - Select transfers in/out
   - Pass to backend

3. **Persistence** (Future)
   - Save chip selections per team
   - LocalStorage or backend config

---

**Built by GSD Builder (Flash) in 90 minutes ⚡**
