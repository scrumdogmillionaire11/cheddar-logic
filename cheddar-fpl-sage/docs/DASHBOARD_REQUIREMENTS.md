# Dashboard Integration Requirements

**For integrating your Node.js dashboard with FPL Sage API**

## Minimal Requirements (Get It Working)

### 1. API Client Setup

```javascript
const SAGE_API = 'http://localhost:8001/api/v1';

// Function to trigger analysis
async function triggerSageAnalysis(teamId, freeTransfers = 1) {
  const response = await axios.post(`${SAGE_API}/analyze/interactive`, {
    team_id: teamId,
    free_transfers: freeTransfers,
    available_chips: [],
    risk_posture: 'balanced'
  });
  
  return response.data.analysis_id;
}

// Function to get dashboard data
async function getSageData(analysisId) {
  const response = await axios.get(`${SAGE_API}/dashboard/${analysisId}/simple`);
  return response.data;
}
```

### 2. Polling Loop (Analysis Takes 5-10 Seconds)

```javascript
async function waitForAnalysis(analysisId, maxAttempts = 30) {
  for (let i = 0; i < maxAttempts; i++) {
    const data = await getSageData(analysisId);
    
    if (data.status === 'completed') {
      return data;
    }
    
    if (data.status === 'failed') {
      throw new Error(`Analysis failed: ${data.error}`);
    }
    
    // Wait 2 seconds before next check
    await new Promise(resolve => setTimeout(resolve, 2000));
  }
  
  throw new Error('Analysis timed out');
}
```

### 3. Complete Integration Flow

```javascript
async function getDashboardData(teamId) {
  // Step 1: Trigger analysis
  const analysisId = await triggerSageAnalysis(teamId);
  
  // Step 2: Wait for completion
  const sageData = await waitForAnalysis(analysisId);
  
  // Step 3: Return in your dashboard format
  return {
    gameweek: {
      current: sageData.gameweek,
      deadline: null  // You can still fetch from FPL API if needed
    },
    
    // Weaknesses - Maps directly
    weaknesses: sageData.transfers
      ?.filter(t => t.action === 'OUT')
      .map(t => ({
        type: t.reason.includes('injury') ? 'injury' : 
              t.reason.includes('violation') ? 'squad_rule' : 'form',
        severity: t.priority === 'URGENT' ? 'high' : 'medium',
        player: t.player_name,
        detail: t.reason,
        action: `Transfer out for ${getMatchingInPlayer(sageData.transfers, t)}`
      })) || [],
    
    // Transfer Targets - Just the IN transfers
    transferTargets: sageData.transfers
      ?.filter(t => t.action === 'IN')
      .map(t => ({
        name: t.player_name,
        team: t.team,
        position: t.position,
        cost: t.price,
        expected_points: t.expected_points,
        priority: t.priority,
        reason: t.reason
      })) || [],
    
    // Captain - Already in good format
    captain: sageData.captain,
    
    // Your existing team data (still fetch from FPL API)
    myTeam: await fetchFromFPLAPI(teamId),
    
    // Your existing fixture analysis (keep using your analyzer)
    fixtureAnalysis: await yourFixtureAnalyzer(teamId),
    
    // Decision summary (new!)
    decision: {
      primary: sageData.decision,
      reasoning: sageData.reasoning,
      confidence: parseFloat(sageData.confidence || 0)
    }
  };
}

function getMatchingInPlayer(transfers, outTransfer) {
  const inTransfer = transfers?.find(t => 
    t.action === 'IN' && t.priority === outTransfer.priority
  );
  return inTransfer?.player_name || 'suggested player';
}
```

## Response Format You'll Receive

### Simple Format (Recommended)

```json
{
  "status": "completed",
  "gameweek": 22,
  "decision": "URGENT_TRANSFER",
  "reasoning": "Squad rule violation detected (MCI players=4). One forced transfer required.",
  "transfers": [
    {
      "action": "OUT",
      "player_name": "Guéhi",
      "position": "DEF",
      "team": "MCI",
      "price": 5.2,
      "priority": "URGENT",
      "reason": "Squad rule violation - 4 MCI players (max 3)",
      "injury_status": "Available",
      "expected_points": 3.54
    },
    {
      "action": "IN",
      "player_name": "Thiaw",
      "position": "DEF",
      "team": "NEW",
      "price": 5.1,
      "priority": "URGENT",
      "reason": "Replace Guéhi to resolve squad violation",
      "injury_status": "Available",
      "expected_points": 6.44
    }
  ],
  "captain": {
    "name": "Wirtz",
    "team": "LIV",
    "position": "MID",
    "ownership_pct": 13.1,
    "rationale": "Top projected points in XI (7.8pts)"
  },
  "analysis_id": "abc123def",
  "timestamp": "2026-02-15T..."
}
```

## Dashboard Display Requirements

### Required Sections

**1. Decision Summary Card**
```javascript
// Display prominently at top
<DecisionCard>
  <Badge color={getDecisionColor(data.decision)}>
    {data.decision}  // HOLD / TRANSFER / URGENT_TRANSFER
  </Badge>
  <p>{data.reasoning}</p>
</DecisionCard>
```

**2. Transfer Recommendations**
```javascript
// Show priority with visual indicators
transfers.forEach(transfer => {
  if (transfer.action === 'OUT') {
    <OutTransfer 
      player={transfer.player_name}
      reason={transfer.reason}
      urgency={transfer.priority}  // URGENT = red, HIGH = orange
    />
  } else {
    <InTransfer
      player={transfer.player_name}
      expectedPoints={transfer.expected_points}
      cost={transfer.price}
      urgency={transfer.priority}
    />
  }
})
```

**3. Captain Recommendation**
```javascript
<CaptainCard>
  <h3>Captain: {captain.name}</h3>
  <p>{captain.team} - {captain.position}</p>
  <p>{captain.rationale}</p>
  <small>{captain.ownership_pct}% ownership</small>
</CaptainCard>
```

**4. Team Weaknesses** (if any)
```javascript
// Only show if weaknesses exist
if (weaknesses.length > 0) {
  <WeaknessesSection>
    {weaknesses.map(w => 
      <WeaknessCard severity={w.severity}>
        <Icon type={w.type} />
        <p>{w.player}: {w.detail}</p>
        <p>Action: {w.action}</p>
      </WeaknessCard>
    )}
  </WeaknessesSection>
}
```

## Visual Indicators

### Priority Colors
```javascript
const PRIORITY_COLORS = {
  'URGENT': '#dc2626',    // Red
  'HIGH': '#ea580c',      // Orange
  'MEDIUM': '#eab308',    // Yellow
  'LOW': '#22c55e'        // Green
};

const DECISION_COLORS = {
  'HOLD': '#22c55e',            // Green
  'TRANSFER': '#eab308',        // Yellow
  'URGENT_TRANSFER': '#dc2626'  // Red
};
```

### Status Badges
```javascript
function getBadgeStyle(priority) {
  switch(priority) {
    case 'URGENT':
      return 'bg-red-100 text-red-800 border-red-300';
    case 'HIGH':
      return 'bg-orange-100 text-orange-800 border-orange-300';
    case 'MEDIUM':
      return 'bg-yellow-100 text-yellow-800 border-yellow-300';
    default:
      return 'bg-green-100 text-green-800 border-green-300';
  }
}
```

## Hybrid Approach (Recommended)

Keep what works from your current analyzer, enhance with FPL Sage:

```javascript
async function getEnhancedDashboardData(teamId) {
  // Run both in parallel
  const [sageData, yourData] = await Promise.all([
    getDashboardData(teamId).catch(() => null),  // Graceful fallback
    yourAnalyzer.getDashboardData(teamId)
  ]);
  
  if (!sageData) {
    // FPL Sage failed, use your analyzer
    return yourData;
  }
  
  // Merge: Use Sage for decisions, your analyzer for supporting data
  return {
    ...yourData,
    
    // Override with Sage's smarter recommendations
    transferTargets: sageData.transferTargets,
    weaknesses: sageData.weaknesses,
    captain: sageData.captain,
    
    // Add new fields
    decision: sageData.decision,
    confidence: sageData.confidence,
    
    // Keep your fixture analysis
    fixtureAnalysis: yourData.fixtureAnalysis
  };
}
```

## Loading States

### During Analysis (5-10 seconds)
```javascript
function AnalysisLoadingState() {
  return (
    <div className="loading-card">
      <Spinner />
      <p>Analyzing your team with FPL Sage...</p>
      <p className="text-sm text-gray-500">This takes 5-10 seconds</p>
    </div>
  );
}
```

### Polling Status Updates
```javascript
async function waitForAnalysisWithUpdates(analysisId, onProgress) {
  for (let i = 0; i < 30; i++) {
    onProgress(`Checking analysis status... (${i + 1}/30)`);
    
    const data = await getSageData(analysisId);
    if (data.status === 'completed') return data;
    
    await new Promise(resolve => setTimeout(resolve, 2000));
  }
}
```

## Error Handling

```javascript
async function getSageDataSafely(teamId) {
  try {
    const analysisId = await triggerSageAnalysis(teamId);
    return await waitForAnalysis(analysisId);
  } catch (error) {
    console.error('FPL Sage analysis failed:', error);
    
    // Show error to user
    showNotification({
      type: 'warning',
      title: 'Using fallback analyzer',
      message: 'FPL Sage unavailable, using local analysis'
    });
    
    // Fall back to your analyzer
    return null;
  }
}
```

## Caching Strategy

```javascript
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes
const analysisCache = new Map();

async function getCachedSageData(teamId) {
  const cacheKey = `sage_${teamId}`;
  const cached = analysisCache.get(cacheKey);
  
  if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
    return cached.data;
  }
  
  const data = await getDashboardData(teamId);
  analysisCache.set(cacheKey, {
    data,
    timestamp: Date.now()
  });
  
  return data;
}
```

## Testing Checklist

- [ ] Backend running: `uvicorn backend.main:app --reload --port 8001`
- [ ] Can trigger analysis: `POST /api/v1/analyze/interactive`
- [ ] Can fetch results: `GET /api/v1/dashboard/{id}/simple`
- [ ] Polling works (waits for completion)
- [ ] Transfer recommendations display correctly
- [ ] Priority badges show right colors
- [ ] Captain card renders
- [ ] Error handling works (backend down)
- [ ] Loading states during analysis
- [ ] Caching prevents duplicate analyses

## Quick Test Script

```javascript
// test-sage-integration.js
const axios = require('axios');

const SAGE_API = 'http://localhost:8001/api/v1';
const TEST_TEAM_ID = 1930561;

async function testIntegration() {
  console.log('🧪 Testing FPL Sage Integration...\n');
  
  // Step 1: Trigger
  console.log('Step 1: Triggering analysis...');
  const { data: { analysis_id } } = await axios.post(
    `${SAGE_API}/analyze/interactive`,
    {
      team_id: TEST_TEAM_ID,
      free_transfers: 1,
      available_chips: [],
      risk_posture: 'balanced'
    }
  );
  console.log(`✅ Analysis ID: ${analysis_id}\n`);
  
  // Step 2: Poll
  console.log('Step 2: Waiting for completion...');
  let result;
  for (let i = 0; i < 30; i++) {
    await new Promise(resolve => setTimeout(resolve, 2000));
    const { data } = await axios.get(`${SAGE_API}/dashboard/${analysis_id}/simple`);
    
    if (data.status === 'completed') {
      result = data;
      break;
    }
    console.log(`  ⏳ Still running... (${i + 1}/30)`);
  }
  
  if (!result) {
    console.error('❌ Analysis timed out');
    return;
  }
  
  // Step 3: Display
  console.log('✅ Analysis complete!\n');
  console.log('📊 Results:');
  console.log(`Decision: ${result.decision}`);
  console.log(`Reasoning: ${result.reasoning}`);
  console.log(`\nTransfers: ${result.transfers?.length || 0}`);
  result.transfers?.forEach(t => {
    console.log(`  ${t.action}: ${t.player_name} (${t.priority})`);
  });
  console.log(`\nCaptain: ${result.captain?.name} - ${result.captain?.rationale}`);
}

testIntegration().catch(console.error);
```

## Summary: What You Need

**Backend Running:**
- FPL Sage API: `http://localhost:8001`

**Your Dashboard Changes:**
1. Add axios client for FPL Sage API
2. Implement polling loop (2-second intervals)
3. Map response to your display format
4. Add loading state (5-10 seconds)
5. Add error handling with fallback

**UI Updates:**
1. Decision summary card (new)
2. Priority badges on transfers (URGENT/HIGH/MEDIUM)
3. Confidence indicator (new)
4. Loading spinner during analysis

**Optional:**
- Caching (5 min TTL)
- WebSocket for real-time updates
- Hybrid mode (Sage + your analyzer)

**Test Command:**
```bash
node test-sage-integration.js
```

---

**Total Integration Time:** 2-4 hours for basic, 6-8 hours for polished
**Difficulty:** Moderate (mainly async/polling logic)
**Breaking Changes:** None (keep your existing analyzer as fallback)
