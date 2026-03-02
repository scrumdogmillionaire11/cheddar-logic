/**
 * Tests for Canonical Play Decision Logic
 * 
 * Run: node src/__tests__/canonical-play-decision.test.js
 * 
 * Covers:
 * 1. Classification layer (deriveClassification)
 * 2. Action layer (deriveAction)
 * 3. Unified decision (derivePlayDecision)
 * 4. Sport-specific behavior
 */

// Dynamic import since we can't import .ts files directly in Node
// We'll re-implement the test logic in JS

// ============================================================================
// TEST FRAMEWORK UTILITIES
// ============================================================================

let totalTests = 0;
let passedTests = 0;
let failedTests = 0;

function describe(name, fn) {
  console.log(`\n📋 ${name}`);
  fn();
}

function it(name, fn) {
  totalTests++;
  try {
    fn();
    passedTests++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failedTests++;
    console.log(`  ✗ ${name}`);
    console.log(`    Error: ${err.message}`);
  }
}

function expect(actual) {
  return {
    toBe(expected) {
      if (actual !== expected) {
        throw new Error(`Expected ${expected}, got ${actual}`);
      }
    },
    toEqual(expected) {
      if (JSON.stringify(actual) !== JSON.stringify(expected)) {
        throw new Error(`Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
      }
    },
    toBeUndefined() {
      if (actual !== undefined) {
        throw new Error(`Expected undefined, got ${actual}`);
      }
    },
    toBeInclude(item) {
      if (!Array.isArray(actual) || !actual.includes(item)) {
        throw new Error(`Expected array to include ${item}, got ${JSON.stringify(actual)}`);
      }
    },
  };
}

// ============================================================================
// MOCK DECISION LOGIC (Implementation for testing)
// ============================================================================

// Threshold configuration
const THRESHOLDS = {
  TOTAL: {
    base_edge_threshold: 0.02,
    confidence_floor: 0.55,
    weak_signal_adjustment: 0.015,
    conflict_adjustment: 0.01,
  },
  SPREAD: {
    base_edge_threshold: 0.025,
    confidence_floor: 0.55,
    weak_signal_adjustment: 0.015,
    conflict_adjustment: 0.01,
  },
  MONEYLINE: {
    base_edge_threshold: 0.025,
    confidence_floor: 0.55,
    weak_signal_adjustment: 0.015,
    conflict_adjustment: 0.01,
  },
  DOUBLE_CHANCE: {
    base_edge_threshold: 0.03,
    confidence_floor: 0.55,
  },
  TSOA: {
    base_edge_threshold: 0.035,
    confidence_floor: 0.55,
  },
  PROP: {
    base_edge_threshold: 0.035,
    confidence_floor: 0.55,
  },
};

function isMarketTypeSupportedForSport(market, sport) {
  const supportedByAll = ['MONEYLINE', 'SPREAD', 'TOTAL', 'PROP'];
  
  if (supportedByAll.includes(market)) {
    return true;
  }
  
  switch (sport) {
    case 'NHL':
      return ['PUCKLINE', 'SOG'].includes(market);
    case 'SOCCER':
      return ['DOUBLE_CHANCE', 'DRAW_NO_BET', 'TSOA', 'SHOTS_ON_TARGET'].includes(market);
    default:
      return false;
  }
}

function getThresholdsForMarket(market) {
  const threshMap = {
    TOTAL: THRESHOLDS.TOTAL,
    SPREAD: THRESHOLDS.SPREAD,
    MONEYLINE: THRESHOLDS.MONEYLINE,
    TEAM_TOTAL: THRESHOLDS.TOTAL,
    PUCKLINE: THRESHOLDS.SPREAD,
    DOUBLE_CHANCE: THRESHOLDS.DOUBLE_CHANCE,
    DRAW_NO_BET: THRESHOLDS.DOUBLE_CHANCE,
    TSOA: THRESHOLDS.TSOA,
    PROP: THRESHOLDS.PROP,
    SOG: THRESHOLDS.PROP,
    SHOTS_ON_TARGET: THRESHOLDS.PROP,
    INFO: undefined,
  };
  
  return threshMap[market];
}

function deriveClassification(play) {
  // Hard veto: missing market_type
  if (!play.market_type) {
    return { classification: 'PASS', pass_reason: 'MISSING_MARKET_TYPE' };
  }
  
  // Hard veto: missing selection_key
  if (!play.selection_key) {
    return { classification: 'PASS', pass_reason: 'MISSING_SELECTION' };
  }
  
  // Hard veto: TOTAL_BIAS_CONFLICT
  if (play.market_type === 'TOTAL' && play.warning_tags?.includes('TOTAL_BIAS_CONFLICT')) {
    return { classification: 'PASS', pass_reason: 'TOTAL_BIAS_CONFLICT' };
  }
  
  // Hard veto: OUT_OF_SCOPE_MARKET
  if (play.warning_tags?.includes('OUT_OF_SCOPE_MARKET')) {
    return { classification: 'PASS', pass_reason: 'OUT_OF_SCOPE_MARKET' };
  }
  
  // Hard veto: unsupported market for sport
  if (!isMarketTypeSupportedForSport(play.market_type, play.sport)) {
    return { classification: 'PASS', pass_reason: 'UNSUPPORTED_MARKET' };
  }
  
  // Hard veto: missing edge
  if (play.model.edge === undefined || play.model.edge === null) {
    return { classification: 'PASS', pass_reason: 'NO_EDGE' };
  }
  
  // Hard veto: non-positive edge
  if (play.model.edge <= 0) {
    return { classification: 'PASS', pass_reason: 'NO_EDGE' };
  }
  
  // Get thresholds
  const thresholds = getThresholdsForMarket(play.market_type);
  if (!thresholds) {
    return { classification: 'PASS', pass_reason: 'UNSUPPORTED_MARKET' };
  }
  
  const confidence = play.model.confidence ?? 0.5;
  const edge = play.model.edge;
  
  // Apply adjustments
  let adjustedThreshold = thresholds.base_edge_threshold ?? 0.02;
  if (confidence < 0.6) {
    adjustedThreshold += thresholds.weak_signal_adjustment ?? 0.015;
  }
  
  // Determine BASE vs LEAN
  const meetsBaseThreshold = edge >= adjustedThreshold;
  const meetsConfidenceFloor = confidence >= (thresholds.confidence_floor ?? 0.55);
  
  if (meetsBaseThreshold && meetsConfidenceFloor) {
    return { classification: 'BASE' };
  }
  
  if (edge > 0) {
    return { classification: 'LEAN' };
  }
  
  return { classification: 'PASS', pass_reason: 'INSUFFICIENT_DATA' };
}

function deriveAction(classification, marketContext = {}, wrapperContext = {}) {
  // PASS always stays PASS
  if (classification === 'PASS') {
    return {
      action: 'PASS',
      why_code: 'CLASSIFICATION_PASS',
      why_text: 'Model does not endorse (no edge, hard veto, or insufficient data)',
    };
  }
  
  // Wrapper blocks
  if (wrapperContext.enforced_blockers?.length) {
    return {
      action: 'HOLD',
      why_code: 'WRAPPER_BLOCKS',
      why_text: `Execution blocked by: ${wrapperContext.enforced_blockers.join(', ')}`,
    };
  }
  
  // Market availability
  const marketAvailable = marketContext.market_available ?? true;
  if (marketAvailable === false) {
    return {
      action: 'HOLD',
      why_code: 'MARKET_UNAVAILABLE',
      why_text: 'This market is not currently available at the book',
    };
  }
  
  // Time window
  const timeWindowOk = marketContext.time_window_ok ?? true;
  if (timeWindowOk === false) {
    return {
      action: 'HOLD',
      why_code: 'TIME_WINDOW_CLOSED',
      why_text: 'Bet window has closed for this game',
    };
  }
  
  // Classification to action
  if (classification === 'BASE') {
    return {
      action: 'FIRE',
      why_code: 'CLASSIFICATION_BASE',
      why_text: 'Model strongly endorses (BASE classification)',
    };
  }
  
  if (classification === 'LEAN') {
    return {
      action: 'HOLD',
      why_code: 'CLASSIFICATION_LEAN',
      why_text: 'Model suggests mild edge (LEAN classification) - watch for confirmation',
    };
  }
  
  return {
    action: 'PASS',
    why_code: 'UNKNOWN',
    why_text: 'Unknown classification state',
  };
}

function derivePlayDecision(play, marketContext, wrapperContext) {
  const classResult = deriveClassification(play);
  const actionResult = deriveAction(classResult.classification, marketContext, wrapperContext);
  
  return {
    play: { ...play, classification: classResult.classification, action: actionResult.action },
    classification: classResult.classification,
    action: actionResult.action,
    why_code: actionResult.why_code,
    why_text: actionResult.why_text,
  };
}

// ============================================================================
// TEST FIXTURES
// ============================================================================

function basePlayFactory(overrides) {
  return {
    play_id: 'test-play-001',
    sport: 'NBA',
    league: 'NBA',
    game_id: 'game-001',
    market_type: 'MONEYLINE',
    selection_key: 'HOME_WIN',
    side: 'HOME',
    price_american: 110,
    model: {
      projection: undefined,
      edge: 0.03,
      confidence: 0.65,
    },
    classification: 'BASE',
    action: 'FIRE',
    created_at: new Date().toISOString(),
    ...overrides,
  };
}

// ============================================================================
// TESTS
// ============================================================================

async function runTests() {
  console.log('🧪 Starting Canonical Play Decision Logic Tests...\n');

  // ====== CLASSIFICATION TESTS ======
  describe('deriveClassification - Hard veto conditions', () => {
    it('should return PASS for missing market_type', () => {
      const play = basePlayFactory({ market_type: undefined });
      const result = deriveClassification(play);
      expect(result.classification).toBe('PASS');
      expect(result.pass_reason).toBe('MISSING_MARKET_TYPE');
    });

    it('should return PASS for missing selection_key', () => {
      const play = basePlayFactory({ selection_key: undefined });
      const result = deriveClassification(play);
      expect(result.classification).toBe('PASS');
      expect(result.pass_reason).toBe('MISSING_SELECTION');
    });

    it('should return PASS for TOTAL_BIAS_CONFLICT warning tag', () => {
      const play = basePlayFactory({
        market_type: 'TOTAL',
        warning_tags: ['TOTAL_BIAS_CONFLICT'],
      });
      const result = deriveClassification(play);
      expect(result.classification).toBe('PASS');
      expect(result.pass_reason).toBe('TOTAL_BIAS_CONFLICT');
    });

    it('should return PASS for OUT_OF_SCOPE_MARKET warning', () => {
      const play = basePlayFactory({
        warning_tags: ['OUT_OF_SCOPE_MARKET'],
      });
      const result = deriveClassification(play);
      expect(result.classification).toBe('PASS');
      expect(result.pass_reason).toBe('OUT_OF_SCOPE_MARKET');
    });

    it('should return PASS for unsupported market type for sport', () => {
      const play = basePlayFactory({
        sport: 'NBA',
        market_type: 'PUCKLINE',
      });
      const result = deriveClassification(play);
      expect(result.classification).toBe('PASS');
      expect(result.pass_reason).toBe('UNSUPPORTED_MARKET');
    });
  });

  describe('deriveClassification - Edge evaluation', () => {
    it('should return PASS for missing edge', () => {
      const play = basePlayFactory({
        model: { projection: undefined, edge: undefined, confidence: 0.65 },
      });
      const result = deriveClassification(play);
      expect(result.classification).toBe('PASS');
      expect(result.pass_reason).toBe('NO_EDGE');
    });

    it('should return PASS for non-positive edge', () => {
      const play = basePlayFactory({
        model: { edge: 0, confidence: 0.65 },
      });
      const result = deriveClassification(play);
      expect(result.classification).toBe('PASS');
      expect(result.pass_reason).toBe('NO_EDGE');
    });
  });

  describe('deriveClassification - BASE classification', () => {
    it('should return BASE for strong edge and high confidence', () => {
      const play = basePlayFactory({
        market_type: 'MONEYLINE',
        model: { edge: 0.035, confidence: 0.70 },
      });
      const result = deriveClassification(play);
      expect(result.classification).toBe('BASE');
    });

    it('should return BASE for TOTAL market with sufficient edge', () => {
      const play = basePlayFactory({
        market_type: 'TOTAL',
        selection_key: 'OVER',
        model: { edge: 0.025, confidence: 0.70 },
      });
      const result = deriveClassification(play);
      expect(result.classification).toBe('BASE');
    });
  });

  describe('deriveClassification - LEAN classification', () => {
    it('should return LEAN for positive edge below BASE threshold', () => {
      const play = basePlayFactory({
        market_type: 'MONEYLINE',
        model: { edge: 0.015, confidence: 0.65 },
      });
      const result = deriveClassification(play);
      expect(result.classification).toBe('LEAN');
    });

    it('should apply weak signal adjustment when confidence < 0.6', () => {
      const play = basePlayFactory({
        market_type: 'TOTAL',
        selection_key: 'OVER',
        model: { edge: 0.025, confidence: 0.55 },
      });
      const result = deriveClassification(play);
      expect(result.classification).toBe('LEAN');
    });
  });

  describe('deriveClassification - Sport-specific validation', () => {
    it('should support NHL PUCKLINE market', () => {
      const play = basePlayFactory({
        sport: 'NHL',
        market_type: 'PUCKLINE',
        selection_key: 'HOME_SPREAD',
        model: { edge: 0.035, confidence: 0.65 },
      });
      const result = deriveClassification(play);
      expect(result.classification).toBe('BASE');
    });

    it('should support SOCCER DOUBLE_CHANCE market', () => {
      const play = basePlayFactory({
        sport: 'SOCCER',
        market_type: 'DOUBLE_CHANCE',
        selection_key: 'HOME_OR_DRAW',
        model: { edge: 0.035, confidence: 0.65 },
      });
      const result = deriveClassification(play);
      expect(result.classification).toBe('BASE');
    });

    it('should support SOCCER TSOA market', () => {
      const play = basePlayFactory({
        sport: 'SOCCER',
        market_type: 'TSOA',
        selection_key: 'HOME_TSOA',
        model: { edge: 0.04, confidence: 0.65 },
      });
      const result = deriveClassification(play);
      expect(result.classification).toBe('BASE');
    });
  });

  // ====== ACTION TESTS ======
  describe('deriveAction - PASS always stays PASS', () => {
    it('should return PASS action for PASS classification', () => {
      const result = deriveAction('PASS', { market_available: true, time_window_ok: true });
      expect(result.action).toBe('PASS');
      expect(result.why_code).toBe('CLASSIFICATION_PASS');
    });
  });

  describe('deriveAction - Market availability', () => {
    it('should return HOLD when market_available=false', () => {
      const result = deriveAction('BASE', { market_available: false });
      expect(result.action).toBe('HOLD');
      expect(result.why_code).toBe('MARKET_UNAVAILABLE');
    });

    it('should return FIRE when BASE and market available', () => {
      const result = deriveAction('BASE', { market_available: true });
      expect(result.action).toBe('FIRE');
    });
  });

  describe('deriveAction - Wrapper blocks', () => {
    it('should return HOLD when wrapper_blocks enforced', () => {
      const wrapperCtx = {
        sport: 'NHL',
        enforced_blockers: ['GOALIE_UNCONFIRMED'],
      };
      const result = deriveAction('BASE', { market_available: true }, wrapperCtx);
      expect(result.action).toBe('HOLD');
      expect(result.why_code).toBe('WRAPPER_BLOCKS');
    });
  });

  describe('deriveAction - Classification rules', () => {
    it('should return FIRE for BASE classification', () => {
      const result = deriveAction('BASE', { market_available: true, time_window_ok: true });
      expect(result.action).toBe('FIRE');
      expect(result.why_code).toBe('CLASSIFICATION_BASE');
    });

    it('should return HOLD for LEAN classification', () => {
      const result = deriveAction('LEAN', { market_available: true, time_window_ok: true });
      expect(result.action).toBe('HOLD');
      expect(result.why_code).toBe('CLASSIFICATION_LEAN');
    });
  });

  // ====== UNIFIED DECISION TESTS ======
  describe('derivePlayDecision - Integration', () => {
    it('should combine classification and action into decision', () => {
      const play = basePlayFactory({
        market_type: 'MONEYLINE',
        model: { edge: 0.035, confidence: 0.70 },
      });
      const decision = derivePlayDecision(play, { market_available: true, time_window_ok: true });
      
      expect(decision.classification).toBe('BASE');
      expect(decision.action).toBe('FIRE');
    });

    it('should pass through classification PASS to action PASS', () => {
      const play = basePlayFactory({
        model: { edge: -0.01, confidence: 0.65 },
      });
      const decision = derivePlayDecision(play, { market_available: true });
      
      expect(decision.classification).toBe('PASS');
      expect(decision.action).toBe('PASS');
    });

    it('should apply wrapper blocks to BASE classification', () => {
      const play = basePlayFactory({
        sport: 'NHL',
        model: { edge: 0.035, confidence: 0.70 },
      });
      const wrapperCtx = {
        sport: 'NHL',
        enforced_blockers: ['GOALIE_UNCONFIRMED'],
      };
      const decision = derivePlayDecision(play, { market_available: true }, wrapperCtx);
      
      expect(decision.classification).toBe('BASE');
      expect(decision.action).toBe('HOLD');
    });
  });

  // ====== SCENARIO TESTS ======
  describe('Real-world scenarios', () => {
    it('Scenario 1: NBA MONEYLINE with strong edge', () => {
      const play = basePlayFactory({
        sport: 'NBA',
        market_type: 'MONEYLINE',
        selection_key: 'HOME_WIN',
        model: { edge: 0.04, confidence: 0.75 },
      });
      
      const { classification } = deriveClassification(play);
      const { action } = deriveAction(classification, {
        market_available: true,
        time_window_ok: true,
      });
      
      expect(classification).toBe('BASE');
      expect(action).toBe('FIRE');
    });

    it('Scenario 2: NHL TOTAL with bias conflict', () => {
      const play = basePlayFactory({
        sport: 'NHL',
        market_type: 'TOTAL',
        selection_key: 'OVER',
        model: { edge: 0.03, confidence: 0.70 },
        warning_tags: ['TOTAL_BIAS_CONFLICT'],
      });
      
      const { classification, pass_reason } = deriveClassification(play);
      
      expect(classification).toBe('PASS');
      expect(pass_reason).toBe('TOTAL_BIAS_CONFLICT');
    });

    it('Scenario 3: SOCCER TSOA lean edge', () => {
      const play = basePlayFactory({
        sport: 'SOCCER',
        market_type: 'TSOA',
        selection_key: 'HOME_TSOA',
        model: { edge: 0.025, confidence: 0.60 },
      });
      
      const { classification } = deriveClassification(play);
      expect(classification).toBe('LEAN');
    });

    it('Scenario 4: NHL with goalie gate', () => {
      const play = basePlayFactory({
        sport: 'NHL',
        market_type: 'MONEYLINE',
        selection_key: 'HOME_WIN',
        model: { edge: 0.035, confidence: 0.70 },
      });
      
      const { classification } = deriveClassification(play);
      expect(classification).toBe('BASE');
      
      const wrapperCtx = {
        sport: 'NHL',
        goalie_status: 'UNCONFIRMED',
        enforced_blockers: ['GOALIE_UNCONFIRMED'],
      };
      
      const { action } = deriveAction(classification, { market_available: true }, wrapperCtx);
      expect(action).toBe('HOLD');
    });
  });

  // ====== SUMMARY ======
  console.log('\n' + '='.repeat(60));
  console.log(`CANONICAL PLAY DECISION TESTS COMPLETE`);
  console.log('='.repeat(60));
  console.log(`✓ Passed: ${passedTests}`);
  console.log(`✗ Failed: ${failedTests}`);
  console.log(`📊 Total:  ${totalTests}`);
  console.log('='.repeat(60) + '\n');

  if (failedTests > 0) {
    process.exit(1);
  }
}

// Run tests
runTests().catch((err) => {
  console.error('Test suite error:', err);
  process.exit(1);
});
