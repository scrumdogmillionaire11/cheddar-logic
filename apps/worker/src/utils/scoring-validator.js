/**
 * Scoring Validation for Settlement
 *
 * Validates fetched game scores against sport-specific bounds and flags suspicious results.
 * Does NOT block settlement, but logs warnings for post-game audit.
 *
 * Usage:
 *   const validator = new ScoringValidator();
 *   const result = validator.validateGameScore(sport, homeScore, awayScore);
 *   if (!result.valid) console.warn(`Suspicious score: ${result.warnings}`);
 */

'use strict';

const SPORT_BOUNDS = {
  NHL: { minScore: 0, maxScore: 15, note: 'Hockey games rarely exceed 10 goals' },
  NBA: { minScore: 0, maxScore: 200, note: 'NBA games rarely exceed 150 total' },
  NCAAM: { minScore: 0, maxScore: 150, note: 'College basketball 40-120 typical range' },
};

const TYPICAL_TOTALS = {
  NHL: { min: 2, max: 10, common: '3-5' },
  NBA: { min: 150, max: 240, common: '190-220' },
  NCAAM: { min: 80, max: 180, common: '120-160' },
};

class ScoringValidator {
  constructor(options = {}) {
    this.strictMode = options.strictMode ?? false; // If true, warn on outliers
    this.onWarn = options.onWarn ?? console.warn;
  }

  /**
   * Validate a single game's final scores
   * @param {string} sport - 'NHL', 'NBA', 'NCAAM'
   * @param {number} homeScore
   * @param {number} awayScore
   * @returns {object} { valid: boolean, warnings: string[] }
   */
  validateGameScore(sport, homeScore, awayScore) {
    const warnings = [];
    const sportUpper = String(sport || '').toUpperCase();
    const bounds = SPORT_BOUNDS[sportUpper] || { minScore: -100, maxScore: 500 };

    // Check for negative scores (impossible)
    if (homeScore < 0) warnings.push(`Home score is negative: ${homeScore}`);
    if (awayScore < 0) warnings.push(`Away score is negative: ${awayScore}`);

    // Check for bounds violations
    if (homeScore < bounds.minScore) {
      warnings.push(`Home score ${homeScore} below minimum ${bounds.minScore} for ${sport}`);
    }
    if (homeScore > bounds.maxScore) {
      warnings.push(`Home score ${homeScore} exceeds maximum ${bounds.maxScore} for ${sport} (${bounds.note})`);
    }
    if (awayScore < bounds.minScore) {
      warnings.push(`Away score ${awayScore} below minimum ${bounds.minScore} for ${sport}`);
    }
    if (awayScore > bounds.maxScore) {
      warnings.push(`Away score ${awayScore} exceeds maximum ${bounds.maxScore} for ${sport} (${bounds.note})`);
    }

    // Check for suspiciously one-sided games (blowouts > 50 points)
    const diff = Math.abs(homeScore - awayScore);
    if (sportUpper === 'NBA' && diff > 50) {
      warnings.push(`Unusually large spread (${diff} points) — verify not scorer error`);
    } else if (sportUpper === 'NCAAM' && diff > 40) {
      warnings.push(`Unusually large spread (${diff} points) — verify not scorer error`);
    }

    const valid = warnings.length === 0;

    if (!valid && !this.strictMode) {
      // Log warning but allow settlement to proceed
      this.onWarn(`[ScoringValidator] Suspicious scores for ${sport}: ${homeScore}-${awayScore}`, { warnings });
    }

    return { valid, warnings, sport: sportUpper, homeScore, awayScore };
  }

  /**
   * Check if a game is in typical score range (for post-game analysis)
   * @param {string} sport
   * @param {number} homeScore
   * @param {number} awayScore
   * @returns {object} { isTypical: boolean, total: number, expected: string }
   */
  isTypicalScoreRange(sport, homeScore, awayScore) {
    const sportUpper = String(sport || '').toUpperCase();
    const typical = TYPICAL_TOTALS[sportUpper];

    if (!typical) {
      return { isTypical: true, total: homeScore + awayScore, expected: 'unknown' };
    }

    const total = homeScore + awayScore;
    const isTypical = total >= typical.min && total <= typical.max;

    return {
      isTypical,
      total,
      expected: typical.common,
      min: typical.min,
      max: typical.max,
    };
  }

  /**
   * Get validator info for logging/debugging
   * @returns {object}
   */
  getValidatorInfo() {
    return {
      sports: Object.keys(SPORT_BOUNDS),
      bounds: SPORT_BOUNDS,
      typicals: TYPICAL_TOTALS,
    };
  }
}

module.exports = { ScoringValidator, SPORT_BOUNDS, TYPICAL_TOTALS };
