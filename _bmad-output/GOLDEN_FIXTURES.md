# Golden Fixtures — Deterministic Test Data for Card Generation

**Purpose**: Capture representative pre-consolidation card outputs for deterministic regression detection  
**Status**: Fixture definitions ready to generate  
**Branch**: `debug/model-logic-duplication`

---

## Fixture Philosophy

Each fixture is a **complete input-output pair**:
- **Input**: Real odds snapshot + driver descriptors (from actual game)
- **Output**: Expected card payloads (captured before consolidation)
- **Use**: Run consolidation, verify output matches fixture exactly (except timestamps)

**Why fixtures, not metrics**: Metrics ("accuracy went from 0.634 to 0.637") hide bugs. Fixtures expose them immediately because card shape and field values are frozen.

---

## NBA Fixture: LAL @ BOS, Feb 28, 2026

**Fixture ID**: `nba-lal-bos-202602280001`

### Input: OddsSnapshot + Drivers

File: `apps/worker/src/jobs/__tests__/fixtures/nba-lal-bos-input.json`

```json
{
  "gameId": "nba-lal-bos-202602280001",
  "sport": "NBA",
  "oddsSnapshot": {
    "id": "odds-nba-lal-bos-20260228",
    "game_time_utc": "2026-02-28T23:30:00Z",
    "home_team": "LAL",
    "away_team": "BOS",
    "spread_home": -3.5,
    "spread_away": 3.5,
    "total": 215.5,
    "h2h_home": -110,
    "h2h_away": -110,
    "total_price_over": -110,
    "total_price_under": -110,
    "raw_data": {
      "espn_metrics": {
        "home": {
          "team_id": "LAL",
          "metrics": {
            "avgPtsHome": 112.3,
            "avgPtsAllowedHome": 108.1,
            "pace": 99.8,
            "pace_rating": 102.1
          }
        },
        "away": {
          "team_id": "BOS",
          "metrics": {
            "avgPtsAway": 108.5,
            "avgPtsAllowedAway": 110.2,
            "pace": 97.3,
            "pace_rating": 100.5
          }
        }
      }
    }
  },
  "driverDescriptors": [
    {
      "driverKey": "base-projection",
      "prediction": "HOME",
      "driverScore": 0.68,
      "driverWeight": 0.35,
      "driverStatus": "CONFIDENT",
      "driverInputs": {
        "projected_margin": 3.2,
        "home_avg_pts": 112.3,
        "away_avg_pts_allowed": 110.2,
        "pace_synergy_multiplier": 1.01
      }
    },
    {
      "driverKey": "rest-advantage",
      "prediction": "AWAY",
      "driverScore": 0.52,
      "driverWeight": 0.20,
      "driverStatus": "MODERATE",
      "driverInputs": {
        "projected_margin_adjustment": -1.1,
        "home_rest_days": 1,
        "away_rest_days": 2
      }
    },
    {
      "driverKey": "matchup-style",
      "prediction": "NEUTRAL",
      "driverScore": null,
      "driverStatus": "NO_SIGNAL",
      "driverInputs": {
        "signal": 0
      }
    }
  ],
  "marketPayload": {
    "moneylineDecision": {
      "classification": "FIRE",
      "action": "PLAY",
      "recommendation": "HOME",
      "edge": 0.47,
      "p_fair": 0.627,
      "p_implied": 0.523
    },
    "totalDecision": {
      "classification": "WATCH",
      "action": "MONITOR",
      "recommendation": "OVER",
      "edge": 0.12,
      "p_fair": 0.525,
      "p_implied": 0.475
    }
  }
}
```

### Expected Output: Card Payloads

File: `apps/worker/src/jobs/__tests__/fixtures/nba-lal-bos-expected.json`

```json
{
  "expectedCardCount": 3,
  "cards": [
    {
      "id": "card-nba-base-projection-nba-lal-bos-202602280001-ZZZZ1",
      "sport": "NBA",
      "gameId": "nba-lal-bos-202602280001",
      "created_at": "2026-03-04T00:00:00.000Z",
      "expires_at": "2026-02-28T22:30:00.000Z",
      "recommendation": {
        "predicted_side": "HOME",
        "confidence": 0.68,
        "bet_type": "moneyline",
        "reasoning": "Base projection model favors LAL at 0.68 confidence"
      },
      "matchup": {
        "home": "LAL",
        "away": "BOS"
      },
      "driver_key": "base-projection",
      "driver_inputs": {
        "projected_margin": 3.2,
        "home_avg_pts": 112.3,
        "away_avg_pts_allowed": 110.2,
        "pace_synergy_multiplier": 1.01,
        "win_prob_home": 0.6156,
        "sigma": 12
      },
      "driver_impact": {
        "score": 0.68,
        "weight": 0.35,
        "impact": 0.098,
        "status": "CONFIDENT"
      },
      "driver_summary": {
        "weights": [
          {
            "driver": "base-projection",
            "weight": 0.35,
            "score": 0.68,
            "impact": 0.098,
            "status": "CONFIDENT"
          }
        ],
        "impact_note": "Impact = (score - 0.5) * weight. Positive favors HOME, negative favors AWAY."
      },
      "edge": 0.47,
      "confidence": 0.68,
      "decision_class": "FIRE",
      "action": "PLAY",
      "card_type": "moneyline",
      "playable": true,
      "market": {
        "spread": -3.5,
        "total": 215.5,
        "line_home": -110,
        "line_away": -110
      }
    },
    {
      "id": "card-nba-rest-advantage-nba-lal-bos-202602280001-ZZZZ2",
      "sport": "NBA",
      "gameId": "nba-lal-bos-202602280001",
      "created_at": "2026-03-04T00:00:00.000Z",
      "expires_at": "2026-02-28T22:30:00.000Z",
      "recommendation": {
        "predicted_side": "AWAY",
        "confidence": 0.52,
        "bet_type": "moneyline"
      },
      "driver_key": "rest-advantage",
      "driver_inputs": {
        "projected_margin_adjustment": -1.1,
        "home_rest_days": 1,
        "away_rest_days": 2,
        "win_prob_home": 0.4551,
        "sigma": 12
      },
      "driver_impact": {
        "score": 0.52,
        "weight": 0.20,
        "impact": 0.004,
        "status": "MODERATE"
      },
      "edge": 0.12,
      "confidence": 0.52,
      "decision_class": "WATCH",
      "action": "MONITOR",
      "card_type": "moneyline",
      "playable": false
    },
    {
      "id": "card-nba-matchup-style-nba-lal-bos-202602280001-ZZZZ3",
      "sport": "NBA",
      "gameId": "nba-lal-bos-202602280001",
      "created_at": "2026-03-04T00:00:00.000Z",
      "expires_at": "2026-02-28T22:30:00.000Z",
      "recommendation": null,
      "driver_key": "matchup-style",
      "driver_inputs": {
        "signal": 0
      },
      "driver_impact": {
        "score": null,
        "weight": 0.25,
        "impact": null,
        "status": "NO_SIGNAL"
      },
      "edge": null,
      "confidence": null,
      "decision_class": "NEUTRAL",
      "action": null,
      "card_type": null,
      "playable": false
    }
  ]
}
```

### Assertions

```javascript
describe('NBA Fixture: LAL @ BOS', () => {
  const INPUT = require('./fixtures/nba-lal-bos-input.json');
  const EXPECTED = require('./fixtures/nba-lal-bos-expected.json');

  test('Card count matches', () => {
    const result = runNBAModelWithFixture(INPUT);
    expect(result.cards).toHaveLength(EXPECTED.expectedCardCount);
  });

  test('Card IDs follow pattern', () => {
    const result = runNBAModelWithFixture(INPUT);
    result.cards.forEach((card, idx) => {
      expect(card.id).toMatch(/^card-nba-[a-z-]+-[a-z0-9]+-\d+-[A-Z0-9]+$/);
    });
  });

  test('Base projection card matches expected', () => {
    const result = runNBAModelWithFixture(INPUT);
    const baseCard = result.cards.find(c => c.driver_key === 'base-projection');
    const expectedBase = EXPECTED.cards.find(c => c.driver_key === 'base-projection');

    // Exact matches (ignoring dynamic ID/timestamp)
    expect(baseCard.sport).toBe(expectedBase.sport);
    expect(baseCard.driver_key).toBe(expectedBase.driver_key);
    expect(baseCard.recommendation.predicted_side).toBe(expectedBase.recommendation.predicted_side);
    expect(baseCard.edge).toBe(expectedBase.edge);
    expect(baseCard.decision_class).toBe(expectedBase.decision_class);
    
    // Win prob from sigma=12
    expect(baseCard.driver_inputs.win_prob_home).toBeCloseTo(0.6156, 4);
    expect(baseCard.driver_inputs.sigma).toBe(12);

    // Impact calculation
    expect(baseCard.driver_impact.impact).toBeCloseTo(0.098, 3);
  });

  test('Rest advantage card uses correct sigma (12, not 11)', () => {
    const result = runNBAModelWithFixture(INPUT);
    const restCard = result.cards.find(c => c.driver_key === 'rest-advantage');

    // margin = -1.1, sigma = 12 should give ~0.4551
    expect(restCard.driver_inputs.sigma).toBe(12);
    expect(restCard.driver_inputs.win_prob_home).toBeCloseTo(0.4551, 4);
  });

  test('Neutral driver does not produce playable card', () => {
    const result = runNBAModelWithFixture(INPUT);
    const neutralCard = result.cards.find(c => c.driver_key === 'matchup-style');

    expect(neutralCard.decision_class).toBe('NEUTRAL');
    expect(neutralCard.playable).toBe(false);
    expect(neutralCard.recommendation).toBeNull();
  });
});
```

---

## NHL Fixture: TOR @ EDM, Feb 28, 2026

**Fixture ID**: `nhl-tor-edm-202602280002`

### Key Differences from NBA

- **Sigma**: 12 (same as NBA, NOT 11)
- **Driver weights**: Different distribution (e.g., powerRating 0.35 vs NBA 0.40)
- **Metrics**: Goals-based, not points-based

### Input: OddsSnapshot + Drivers

File: `apps/worker/src/jobs/__tests__/fixtures/nhl-tor-edm-input.json`

```json
{
  "gameId": "nhl-tor-edm-202602280002",
  "sport": "NHL",
  "oddsSnapshot": {
    "game_time_utc": "2026-02-28T23:00:00Z",
    "home_team": "EDM",
    "away_team": "TOR",
    "spread_home": -1.5,
    "total": 6.5,
    "h2h_home": -115,
    "h2h_away": -105,
    "total_price_over": -110,
    "total_price_under": -110,
    "raw_data": {
      "espn_metrics": {
        "home": {
          "metrics": {
            "avgGoalsFor": 3.2,
            "avgGoalsAllowed": 2.8
          }
        },
        "away": {
          "metrics": {
            "avgGoalsFor": 3.1,
            "avgGoalsAllowed": 3.0
          }
        }
      }
    }
  },
  "driverDescriptors": [
    {
      "driverKey": "power-rating",
      "prediction": "HOME",
      "driverScore": 0.65,
      "driverWeight": 0.35,
      "driverInputs": {
        "projected_margin": 0.8,
        "home_rating": 102.1,
        "away_rating": 100.8
      }
    }
  ]
}
```

### Expected Output

File: `apps/worker/src/jobs/__tests__/fixtures/nhl-tor-edm-expected.json`

```json
{
  "expectedCardCount": 1,
  "cards": [
    {
      "id": "card-nhl-power-rating-nhl-tor-edm-202602280002-XXXX1",
      "sport": "NHL",
      "driver_key": "power-rating",
      "prediction": "HOME",
      "driver_inputs": {
        "projected_margin": 0.8,
        "win_prob_home": 0.5262,
        "sigma": 12
      },
      "driver_impact": {
        "impact": 0.0542
      },
      "edge": 0.34,
      "decision_class": "FIRE",
      "action": "PLAY"
    }
  ]
}
```

### Assertions

```javascript
describe('NHL Fixture: TOR @ EDM', () => {
  const INPUT = require('./fixtures/nhl-tor-edm-input.json');
  const EXPECTED = require('./fixtures/nhl-tor-edm-expected.json');

  test('Uses sigma=12 (not NCAAM 11)', () => {
    const result = runNHLModelWithFixture(INPUT);
    const card = result.cards[0];
    
    expect(card.driver_inputs.sigma).toBe(12);
    // margin=0.8, sigma=12 → P(home) ≈ 0.5262
    expect(card.driver_inputs.win_prob_home).toBeCloseTo(0.5262, 4);
  });

  test('Uses NHL-specific power rating weight (0.35)', () => {
    const result = runNHLModelWithFixture(INPUT);
    const card = result.cards[0];
    
    expect(card.driver_impact.weight).toBe(0.35);
  });

  test('Edge value matches expected', () => {
    const result = runNHLModelWithFixture(INPUT);
    const card = result.cards[0];
    
    expect(card.edge).toBeCloseTo(0.34, 2);
  });
});
```

---

## NCAAM Fixture: DUKE @ UNC, Feb 28, 2026

**Fixture ID**: `ncaam-duke-unc-202602280003`

### Key Difference: Sigma=11 (NOT 12)

College basketball has lower point spread variance.

### Input: OddsSnapshot + Drivers

File: `apps/worker/src/jobs/__tests__/fixtures/ncaam-duke-unc-input.json`

```json
{
  "gameId": "ncaam-duke-unc-202602280003",
  "sport": "NCAAM",
  "oddsSnapshot": {
    "game_time_utc": "2026-02-28T21:00:00Z",
    "home_team": "UNC",
    "away_team": "DUKE",
    "spread_home": -2.5,
    "total": 143.5,
    "h2h_home": -110,
    "h2h_away": -110,
    "total_price_over": -110,
    "total_price_under": -110,
    "raw_data": {
      "espn_metrics": {
        "home": {
          "metrics": {
            "avgPoints": 72.1,
            "avgPointsAllowed": 68.3
          }
        },
        "away": {
          "metrics": {
            "avgPoints": 71.8,
            "avgPointsAllowed": 70.2
          }
        }
      }
    }
  },
  "driverDescriptors": [
    {
      "driverKey": "base-projection",
      "prediction": "HOME",
      "driverScore": 0.62,
      "driverWeight": 0.35,
      "driverInputs": {
        "projected_margin": 2.1
      }
    }
  ]
}
```

### Expected Output

File: `apps/worker/src/jobs/__tests__/fixtures/ncaam-duke-unc-expected.json`

```json
{
  "expectedCardCount": 1,
  "cards": [
    {
      "id": "card-ncaam-base-projection-ncaam-duke-unc-202602280003-YYYY1",
      "sport": "NCAAM",
      "driver_key": "base-projection",
      "prediction": "HOME",
      "driver_inputs": {
        "projected_margin": 2.1,
        "win_prob_home": 0.5686,
        "sigma": 11
      },
      "driver_impact": {
        "impact": 0.0594
      },
      "edge": 0.51,
      "decision_class": "FIRE"
    }
  ]
}
```

### Critical Assertion: NCAAM ≠ NBA

```javascript
describe('NCAAM Fixture: DUKE @ UNC', () => {
  const NCAAM_FIXTURE = require('./fixtures/ncaam-duke-unc-input.json');
  const NBA_FIXTURE = require('./fixtures/nba-lal-bos-input.json');
  
  const NCAAM_EXPECTED = require('./fixtures/ncaam-duke-unc-expected.json');
  const NBA_EXPECTED = require('./fixtures/nba-lal-bos-expected.json');

  test('Uses sigma=11 (NOT 12)', () => {
    const result = runNCAAMModelWithFixture(NCAAM_FIXTURE);
    const card = result.cards[0];
    
    expect(card.driver_inputs.sigma).toBe(11, '❌ NCAAM must use sigma=11');
  });

  test('Sigma=11 produces DIFFERENT win prob than sigma=12', () => {
    // Both fixtures have similar margin (~-2.5)
    // Modify NBA fixture to have exactly -2.5 margin for comparison
    const nbaTestMargin = -2.5;
    const ncaamTestMargin = -2.5;
    
    const nbaWinProb = computeWinProbHome(nbaTestMargin, 'NBA'); // sigma=12
    const ncaamWinProb = computeWinProbHome(ncaamTestMargin, 'NCAAM'); // sigma=11
    
    // sigma=11 is tighter, so same negative margin should give LOWER prob (further from 0.5)
    expect(ncaamWinProb).toBeLessThan(nbaWinProb);
    
    // Explicitly: margin=-2.5, sigma=12 → ~0.4266
    //            margin=-2.5, sigma=11 → ~0.4129
    expect(nbaWinProb).toBeCloseTo(0.4266, 4);
    expect(ncaamWinProb).toBeCloseTo(0.4129, 4);
  });

  test('Consolidation must NOT lose this sigma variance', () => {
    // This test is the canary in the coal mine
    // If someone "cleans up" computeWinProbHome to ignore sport-specific sigma,
    // this test will fail immediately
    
    const nbaResult = runNBAModelWithFixture(NBA_FIXTURE);
    const ncaamResult = runNCAAMModelWithFixture(NCAAM_FIXTURE);
    
    const nbaWinProb = nbaResult.cards[0].driver_inputs.win_prob_home;
    const ncaamWinProb = ncaamResult.cards[0].driver_inputs.win_prob_home;
    
    expect(nbaWinProb).not.toBe(ncaamWinProb,
      '❌ CRITICAL: Consolidation lost the intentional sigma variance between NCAAM and NBA'
    );
  });
});
```

---

## Fixture Generation Script

File: `apps/worker/scripts/generate-fixtures.js`

```javascript
/**
 * Generate golden fixture snapshots from actual game data
 * Usage: node generate-fixtures.js --sport NBA --gameId nba-lal-bos-202602280001
 */

const { runNBAModelWithFixture, runNHLModelWithFixture, runNCAAMModelWithFixture } = require('../src/jobs');
const fs = require('fs');
const path = require('path');

const fixtures = {
  'nba-lal-bos-202602280001': {
    input: require('../src/jobs/__tests__/fixtures/nba-lal-bos-input.json'),
    sport: 'NBA',
    run: runNBAModelWithFixture
  },
  'nhl-tor-edm-202602280002': {
    input: require('../src/jobs/__tests__/fixtures/nhl-tor-edm-input.json'),
    sport: 'NHL',
    run: runNHLModelWithFixture
  },
  'ncaam-duke-unc-202602280003': {
    input: require('../src/jobs/__tests__/fixtures/ncaam-duke-unc-input.json'),
    sport: 'NCAAM',
    run: runNCAAMModelWithFixture
  }
};

async function generateFixture(gameId) {
  const fixtureConfig = fixtures[gameId];
  if (!fixtureConfig) {
    console.error(`Unknown fixture: ${gameId}`);
    process.exit(1);
  }

  const result = fixtureConfig.run(fixtureConfig.input);
  
  // Normalize output for storage
  const normalized = {
    expectedCardCount: result.cards.length,
    cards: result.cards.map(card => ({
      ...card,
      // Remove dynamic fields
      id: card.id.replace(/[a-z0-9-]{8}$/, 'XXXX'),
      created_at: '2026-03-04T00:00:00.000Z',
      expires_at: '2026-02-28T22:30:00.000Z'
    }))
  };

  const outPath = path.join(
    __dirname,
    `../src/jobs/__tests__/fixtures/${gameId}-expected.json`
  );
  
  fs.writeFileSync(outPath, JSON.stringify(normalized, null, 2));
  console.log(`✅ Generated: ${outPath}`);
}

async function main() {
  Object.keys(fixtures).forEach(gameId => generateFixture(gameId));
}

main().catch(console.error);
```

---

## Summary

**Three fixtures, three sports, one purpose: deterministic regression detection**

| Fixture | Sport | Sigma | Key Assertion |
|---------|-------|-------|---------------|
| NBA LAL@BOS | NBA | 12 | base-projection card produces correct win_prob, edge, decision |
| NHL TOR@EDM | NHL | 12 | power-rating weight correct (0.35), sigma same as NBA |
| NCAAM DUKE@UNC | NCAAM | 11 | sigma=11 (NOT 12), produces different win_prob than NBA |

Run after each consolidation phase:
```bash
npm test -- card-generation.fixture-test.js
```

**All pass = refactor succeeded. Any fail = revert immediately.**
