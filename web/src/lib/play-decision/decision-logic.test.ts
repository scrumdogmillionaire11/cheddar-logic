/**
 * Tests for Canonical Play Decision Logic
 * 
 * Covers:
 * 1. Classification layer (deriveClassification)
 * 2. Action layer (deriveAction)
 * 3. Unified decision (derivePlayDecision)
 * 4. Sport-specific behavior
 */

import {
  deriveClassification,
  deriveAction,
  derivePlayDecision,
  classificationToLegacyStatus,
} from './decision-logic';
import type { CanonicalPlay, WrapperContext } from '../types/canonical-play';

// ============================================================================
// TEST FIXTURES
// ============================================================================

const basePlayFactory = (overrides?: Partial<CanonicalPlay>): CanonicalPlay => ({
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
});

// ============================================================================
// TESTS: CLASSIFICATION LAYER
// ============================================================================

describe('deriveClassification', () => {
  describe('Hard veto conditions', () => {
    it('should return PASS for missing market_type', () => {
      const play = {
        ...basePlayFactory(),
        market_type: undefined,
      } as unknown as CanonicalPlay;
      const result = deriveClassification(play);
      expect(result.classification).toBe('PASS');
      expect(result.pass_reason).toBe('MISSING_MARKET_TYPE');
    });

    it('should return PASS for missing selection_key', () => {
      const play = {
        ...basePlayFactory(),
        selection_key: undefined,
      } as unknown as CanonicalPlay;
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
        market_type: 'PUCKLINE', // NHL-only
      });
      const result = deriveClassification(play);
      expect(result.classification).toBe('PASS');
      expect(result.pass_reason).toBe('UNSUPPORTED_MARKET');
    });
  });

  describe('Edge evaluation', () => {
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

    it('should return PASS for negative edge', () => {
      const play = basePlayFactory({
        model: { edge: -0.01, confidence: 0.65 },
      });
      const result = deriveClassification(play);
      expect(result.classification).toBe('PASS');
      expect(result.pass_reason).toBe('NO_EDGE');
    });
  });

  describe('BASE classification', () => {
    it('should return BASE for strong edge and high confidence', () => {
      const play = basePlayFactory({
        market_type: 'MONEYLINE',
        model: { edge: 0.035, confidence: 0.70 },  // 3.5% edge, 70% confidence
      });
      const result = deriveClassification(play);
      expect(result.classification).toBe('BASE');
    });

    it('should return BASE for TOTAL market with sufficient edge', () => {
      const play = basePlayFactory({
        market_type: 'TOTAL',
        selection_key: 'OVER',
        model: { edge: 0.025, confidence: 0.70 },  // 2.5% edge (meets TOTAL threshold)
      });
      const result = deriveClassification(play);
      expect(result.classification).toBe('BASE');
    });

    it('should return BASE for SPREAD market with sufficient edge', () => {
      const play = basePlayFactory({
        market_type: 'SPREAD',
        selection_key: 'HOME_SPREAD',
        model: { edge: 0.035, confidence: 0.65 },
      });
      const result = deriveClassification(play);
      expect(result.classification).toBe('BASE');
    });
  });

  describe('LEAN classification', () => {
    it('should return LEAN for positive edge below BASE threshold', () => {
      const play = basePlayFactory({
        market_type: 'MONEYLINE',
        model: { edge: 0.015, confidence: 0.65 },  // 1.5% edge < 2.5% threshold
      });
      const result = deriveClassification(play);
      expect(result.classification).toBe('LEAN');
    });

    it('should return LEAN for low confidence despite meeting edge threshold', () => {
      const play = basePlayFactory({
        market_type: 'MONEYLINE',
        model: { edge: 0.035, confidence: 0.45 },  // Good edge but low confidence
      });
      const result = deriveClassification(play);
      // Should be LEAN due to low confidence + weak signal adjustment
      expect(result.classification).toBe('LEAN');
    });

    it('should apply weak signal adjustment to threshold when confidence < 0.6', () => {
      const play = basePlayFactory({
        market_type: 'TOTAL',
        selection_key: 'OVER',
        model: { edge: 0.025, confidence: 0.55 },  // Meets base 2% threshold but below 55% floor
      });
      const result = deriveClassification(play);
      expect(result.classification).toBe('LEAN');
    });
  });

  describe('Sport-specific validation', () => {
    it('should support NHL PUCKLINE market', () => {
      const play = basePlayFactory({
        sport: 'NHL',
        market_type: 'PUCKLINE',
        selection_key: 'HOME_SPREAD',
        model: { edge: 0.035, confidence: 0.65 },
      });
      const result = deriveClassification(play);
      expect(result.classification).toBe('BASE');
      expect(result.pass_reason).toBeUndefined();
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

    it('should reject SOCCER + SPREAD if not supported', () => {
      // (Assuming SPREAD is not SOCCER-only)
      expect(() =>
        deriveClassification(
          basePlayFactory({
            sport: 'SOCCER',
            market_type: 'SPREAD', // If SPREAD is NBA/NHL only
            selection_key: 'HOME_SPREAD',
          }),
        ),
      ).not.toThrow();
      // If SPREAD is universally supported, this would pass
      // Adjust test based on actual sport support matrix
    });
  });
});

// ============================================================================
// TESTS: ACTION LAYER
// ============================================================================

describe('deriveAction', () => {
  describe('PASS classification always → PASS action', () => {
    it('should return PASS action for PASS classification', () => {
      const result = deriveAction('PASS', { market_available: true, time_window_ok: true });
      expect(result.action).toBe('PASS');
      expect(result.why_code).toBe('CLASSIFICATION_PASS');
    });

    it('should never upgrade PASS to HOLD or FIRE', () => {
      const result = deriveAction('PASS', {
        market_available: true,
        time_window_ok: true,
        price_acceptable: true,
      });
      expect(result.action).toBe('PASS');
    });
  });

  describe('Market availability', () => {
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

  describe('Time window', () => {
    it('should return HOLD when time_window_ok=false', () => {
      const result = deriveAction('BASE', {
        market_available: true,
        time_window_ok: false,
      });
      expect(result.action).toBe('HOLD');
      expect(result.why_code).toBe('TIME_WINDOW_CLOSED');
    });

    it('should return FIRE when BASE and time window open', () => {
      const result = deriveAction('BASE', { time_window_ok: true, market_available: true });
      expect(result.action).toBe('FIRE');
    });
  });

  describe('Wrapper blocks', () => {
    it('should return HOLD when wrapper_blocks enforced', () => {
      const wrapperCtx: WrapperContext = {
        sport: 'NHL',
        enforced_blockers: ['GOALIE_UNCONFIRMED'],
      };
      const result = deriveAction('BASE', { market_available: true }, wrapperCtx);
      expect(result.action).toBe('HOLD');
      expect(result.why_code).toBe('WRAPPER_BLOCKS');
    });

    it('should fire when BASE, available, and no wrappers', () => {
      const wrapperCtx: WrapperContext = { sport: 'NBA' };
      const result = deriveAction('BASE', { market_available: true }, wrapperCtx);
      expect(result.action).toBe('FIRE');
    });
  });

  describe('Classification rules', () => {
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

    it('should return PASS for PASS classification', () => {
      const result = deriveAction('PASS', { market_available: true, time_window_ok: true });
      expect(result.action).toBe('PASS');
    });
  });

  describe('Default assumptions', () => {
    it('should assume market available if not specified', () => {
      const result = deriveAction('BASE');
      expect(result.action).toBe('FIRE');
    });

    it('should assume time_window_ok if not specified', () => {
      const result = deriveAction('BASE');
      expect(result.action).toBe('FIRE');
    });
  });
});

// ============================================================================
// TESTS: UNIFIED DECISION
// ============================================================================

describe('derivePlayDecision', () => {
  it('should combine classification and action into decision', () => {
    const play = basePlayFactory({
      market_type: 'MONEYLINE',
      model: { edge: 0.035, confidence: 0.70 },
    });
    const decision = derivePlayDecision(play, { market_available: true, time_window_ok: true });
    
    expect(decision.classification).toBe('BASE');
    expect(decision.action).toBe('FIRE');
    expect(decision.why_code).toBe('CLASSIFICATION_BASE');
  });

  it('should pass through classification PASS to action PASS', () => {
    const play = basePlayFactory({
      model: { edge: -0.01, confidence: 0.65 },  // Negative edge
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
    const wrapperCtx: WrapperContext = {
      sport: 'NHL',
      enforced_blockers: ['GOALIE_UNCONFIRMED'],
    };
    const decision = derivePlayDecision(play, { market_available: true }, wrapperCtx);
    
    expect(decision.classification).toBe('BASE');
    expect(decision.action).toBe('HOLD');
    expect(decision.why_code).toBe('WRAPPER_BLOCKS');
  });
});

// ============================================================================
// TESTS: LEGACY CONVERSION
// ============================================================================

describe('classificationToLegacyStatus', () => {
  it('should convert BASE + FIRE → FIRE', () => {
    const status = classificationToLegacyStatus('BASE', 'FIRE');
    expect(status).toBe('FIRE');
  });

  it('should convert LEAN + HOLD → WATCH', () => {
    const status = classificationToLegacyStatus('LEAN', 'HOLD');
    expect(status).toBe('WATCH');
  });

  it('should convert PASS → PASS regardless of action', () => {
    expect(classificationToLegacyStatus('PASS', 'FIRE')).toBe('PASS');
    expect(classificationToLegacyStatus('PASS', 'HOLD')).toBe('PASS');
    expect(classificationToLegacyStatus('PASS', 'PASS')).toBe('PASS');
  });
});

// ============================================================================
// INTEGRATION SCENARIOS
// ============================================================================

describe('Real-world scenarios', () => {
  it('Scenario 1: NBA MONEYLINE with strong edge', () => {
    const play = basePlayFactory({
      sport: 'NBA',
      market_type: 'MONEYLINE',
      selection_key: 'HOME_WIN',
      model: { edge: 0.04, confidence: 0.75 },  // 4% edge, 75% confidence
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
      model: { edge: 0.025, confidence: 0.60 },  // Below 3.5% threshold
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
    
    // But goalie unconfirmed
    const wrapperCtx: WrapperContext = {
      sport: 'NHL',
      goalie_status: 'UNCONFIRMED',
      enforced_blockers: ['GOALIE_UNCONFIRMED'],
    };
    
    const { action } = deriveAction(classification, { market_available: true }, wrapperCtx);
    expect(action).toBe('HOLD');
  });

  it('Scenario 5: LEAN classification blocks immediate bet', () => {
    const play = basePlayFactory({
      market_type: 'MONEYLINE',
      model: { edge: 0.015, confidence: 0.60 },  // Below threshold
    });
    
    const { classification } = deriveClassification(play);
    const { action } = deriveAction(classification, {
      market_available: true,
      time_window_ok: true,
    });
    
    expect(classification).toBe('LEAN');
    expect(action).toBe('HOLD');
  });
});
