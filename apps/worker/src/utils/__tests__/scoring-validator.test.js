/**
 * Tests for ScoringValidator
 *
 * Tests scoring bounds validation, blowout detection, and typical range checks
 */

'use strict';

const { ScoringValidator, SPORT_BOUNDS, TYPICAL_TOTALS } = require('../scoring-validator.js');

describe('ScoringValidator', () => {
  let validator;
  let warnMessages;

  beforeEach(() => {
    warnMessages = [];
    validator = new ScoringValidator({
      strictMode: false,
      onWarn: (msg) => warnMessages.push(msg),
    });
  });

  describe('validateGameScore', () => {
    describe('Negative scores', () => {
      it('should flag negative home score', () => {
        const result = validator.validateGameScore('NHL', -1, 3);
        expect(result.valid).toBe(false);
        expect(result.warnings).toContain('Home score is negative: -1');
      });

      it('should flag negative away score', () => {
        const result = validator.validateGameScore('NHL', 3, -2);
        expect(result.valid).toBe(false);
        expect(result.warnings).toContain('Away score is negative: -2');
      });
    });

    describe('NHL bounds (0-15 per side)', () => {
      it('should accept valid NHL score', () => {
        const result = validator.validateGameScore('NHL', 3, 2);
        expect(result.valid).toBe(true);
        expect(result.warnings).toEqual([]);
      });

      it('should accept 0 (shutout)', () => {
        const result = validator.validateGameScore('NHL', 0, 5);
        expect(result.valid).toBe(true);
      });

      it('should flag score exceeding NHL max', () => {
        const result = validator.validateGameScore('NHL', 20, 3);
        expect(result.valid).toBe(false);
        expect(result.warnings.some(w => w.includes('exceeds maximum'))).toBe(true);
      });
    });

    describe('NBA bounds (0-200 per side)', () => {
      it('should accept valid NBA score', () => {
        const result = validator.validateGameScore('NBA', 115, 108);
        expect(result.valid).toBe(true);
        expect(result.warnings).toEqual([]);
      });

      it('should accept high-scoring NBA game', () => {
        const result = validator.validateGameScore('NBA', 145, 142);
        expect(result.valid).toBe(true);
      });

      it('should flag score exceeding NBA max', () => {
        const result = validator.validateGameScore('NBA', 250, 100);
        expect(result.valid).toBe(false);
        expect(result.warnings.some(w => w.includes('exceeds maximum'))).toBe(true);
      });
    });

    describe('NCAAM bounds (0-150 per side)', () => {
      it('should accept valid NCAAM score', () => {
        const result = validator.validateGameScore('NCAAM', 85, 72);
        expect(result.valid).toBe(true);
        expect(result.warnings).toEqual([]);
      });

      it('should flag score exceeding NCAAM max', () => {
        const result = validator.validateGameScore('NCAAM', 160, 50);
        expect(result.valid).toBe(false);
        expect(result.warnings.some(w => w.includes('exceeds maximum'))).toBe(true);
      });
    });

    describe('Blowout detection', () => {
      it('should flag 50+ point spread in NBA', () => {
        const result = validator.validateGameScore('NBA', 150, 95);
        expect(result.valid).toBe(false);
        expect(result.warnings.some(w => w.includes('Unusually large spread'))).toBe(true);
      });

      it('should not flag normal NBA spread (40 points)', () => {
        const result = validator.validateGameScore('NBA', 140, 100);
        expect(result.valid).toBe(true);
      });

      it('should flag 40+ point spread in NCAAM', () => {
        const result = validator.validateGameScore('NCAAM', 120, 75);
        expect(result.valid).toBe(false);
        expect(result.warnings.some(w => w.includes('Unusually large spread'))).toBe(true);
      });

      it('should not flag major blowout in NHL (no blowout rule)', () => {
        const result = validator.validateGameScore('NHL', 10, 0);
        // Hockey doesn't have blowout detection
        expect(result.warnings.some(w => w.includes('Unusually large'))).toBe(false);
      });
    });

    describe('Return value structure', () => {
      it('should return all expected fields', () => {
        const result = validator.validateGameScore('NHL', 3, 2);
        expect(result).toHaveProperty('valid');
        expect(result).toHaveProperty('warnings');
        expect(result).toHaveProperty('sport');
        expect(result).toHaveProperty('homeScore');
        expect(result).toHaveProperty('awayScore');
      });

      it('should normalize sport to uppercase', () => {
        const result = validator.validateGameScore('nhl', 3, 2);
        expect(result.sport).toBe('NHL');
      });
    });
  });

  describe('isTypicalScoreRange', () => {
    it('should identify typical NHL score', () => {
      const result = validator.isTypicalScoreRange('NHL', 3, 2);
      expect(result.isTypical).toBe(true);
      expect(result.total).toBe(5);
      expect(result.expected).toBe(TYPICAL_TOTALS.NHL.common);
    });

    it('should identify atypical (low) NHL score', () => {
      const result = validator.isTypicalScoreRange('NHL', 0, 0);
      expect(result.isTypical).toBe(false);
      expect(result.total).toBe(0);
      expect(result.min).toBe(TYPICAL_TOTALS.NHL.min);
      expect(result.max).toBe(TYPICAL_TOTALS.NHL.max);
    });

    it('should identify typical NBA score', () => {
      const result = validator.isTypicalScoreRange('NBA', 115, 108);
      expect(result.isTypical).toBe(true);
      expect(result.total).toBe(223);
    });

    it('should identify atypical (high total) NBA score', () => {
      const result = validator.isTypicalScoreRange('NBA', 200, 150);
      expect(result.isTypical).toBe(false);
      expect(result.total).toBe(350);
    });

    it('should identify typical NCAAM score', () => {
      const result = validator.isTypicalScoreRange('NCAAM', 75, 60);
      expect(result.isTypical).toBe(true);
      expect(result.total).toBe(135);
    });

    it('should handle unknown sport gracefully', () => {
      const result = validator.isTypicalScoreRange('UNKNOWN_SPORT', 100, 100);
      expect(result.isTypical).toBe(true); // Defaults to true for unknown
      expect(result.total).toBe(200);
      expect(result.expected).toBe('unknown');
    });
  });

  describe('getValidatorInfo', () => {
    it('should return validator configuration', () => {
      const info = validator.getValidatorInfo();
      expect(info).toHaveProperty('sports');
      expect(info).toHaveProperty('bounds');
      expect(info).toHaveProperty('typicals');
      expect(info.sports).toContain('NHL');
      expect(info.sports).toContain('NBA');
      expect(info.sports).toContain('NCAAM');
    });
  });

  describe('Integration scenarios', () => {
    it('should validate a realistic NHL game', () => {
      const result = validator.validateGameScore('NHL', 4, 3);
      expect(result.valid).toBe(true);
      const typical = validator.isTypicalScoreRange('NHL', 4, 3);
      expect(typical.isTypical).toBe(true);
    });

    it('should validate a realistic NBA game', () => {
      const result = validator.validateGameScore('NBA', 112, 108);
      expect(result.valid).toBe(true);
      const typical = validator.isTypicalScoreRange('NBA', 112, 108);
      expect(typical.isTypical).toBe(true);
    });

    it('should validate a realistic NCAAM game', () => {
      const result = validator.validateGameScore('NCAAM', 72, 68);
      expect(result.valid).toBe(true);
      const typical = validator.isTypicalScoreRange('NCAAM', 72, 68);
      expect(typical.isTypical).toBe(true);
    });

    it('should catch a data entry error (negative home score)', () => {
      const result = validator.validateGameScore('NBA', -115, 108);
      expect(result.valid).toBe(false);
      expect(result.warnings.length).toBeGreaterThan(0);
    });

    it('should warn on implausible blowout', () => {
      const result = validator.validateGameScore('NBA', 200, 90);
      expect(result.valid).toBe(false);
      expect(result.warnings.some(w => w.includes('Unusually large spread'))).toBe(true);
    });
  });
});
