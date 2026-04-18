const {
  describeEdgeMagnitude,
  classifyNhlSogTier,
  normalizeEdgeForBand,
  EDGE_MAGNITUDE_TIERS,
} = require('../edge-thresholds-config');

describe('edge-thresholds-config', () => {
  describe('normalizeEdgeForBand', () => {
    test('rounds to 4 decimal places', () => {
      expect(normalizeEdgeForBand(0.199999999)).toBe(0.2);
      expect(normalizeEdgeForBand(0.050001)).toBe(0.05);
    });

    test('returns 0 for non-finite values', () => {
      expect(normalizeEdgeForBand(NaN)).toBe(0);
      expect(normalizeEdgeForBand(Infinity)).toBe(0);
      expect(normalizeEdgeForBand(-Infinity)).toBe(0);
    });

    test('handles positive and negative values', () => {
      expect(normalizeEdgeForBand(0.123456)).toBe(0.1235);
      expect(normalizeEdgeForBand(-0.123456)).toBe(-0.1235);
    });

    test('returns 0 for null/undefined', () => {
      expect(normalizeEdgeForBand(null)).toBe(0);
      expect(normalizeEdgeForBand(undefined)).toBe(0);
    });
  });

  describe('describeEdgeMagnitude', () => {
    describe('strong threshold (>= 0.2)', () => {
      test('0.2 exactly → strong', () => {
        expect(describeEdgeMagnitude(0.2)).toBe('strong');
      });

      test('0.21 → strong', () => {
        expect(describeEdgeMagnitude(0.21)).toBe('strong');
      });

      test('0.199999999 (precision bug case) → strong after normalization', () => {
        expect(describeEdgeMagnitude(0.199999999)).toBe('strong');
      });

      test('negative -0.2 uses absolute → strong', () => {
        expect(describeEdgeMagnitude(-0.2)).toBe('strong');
      });

      test('negative -0.25 uses absolute → strong', () => {
        expect(describeEdgeMagnitude(-0.25)).toBe('strong');
      });
    });

    describe('thin threshold (0.05 to 0.2)', () => {
      test('0.05 exactly → thin', () => {
        expect(describeEdgeMagnitude(0.05)).toBe('thin');
      });

      test('0.1 → thin', () => {
        expect(describeEdgeMagnitude(0.1)).toBe('thin');
      });

      test('0.1999 → thin (just below strong)', () => {
        expect(describeEdgeMagnitude(0.1999)).toBe('thin');
      });

      test('negative -0.1 uses absolute → thin', () => {
        expect(describeEdgeMagnitude(-0.1)).toBe('thin');
      });
    });

    describe('no label threshold (< 0.05)', () => {
      test('0.04 → null (below thin)', () => {
        expect(describeEdgeMagnitude(0.04)).toBe(null);
      });

      test('0.0 → null', () => {
        expect(describeEdgeMagnitude(0.0)).toBe(null);
      });

      test('negative -0.02 uses absolute → null', () => {
        expect(describeEdgeMagnitude(-0.02)).toBe(null);
      });
    });

    describe('edge cases', () => {
      test('NaN → null (safe return)', () => {
        expect(describeEdgeMagnitude(NaN)).toBe(null);
      });

      test('null → null (safe return)', () => {
        expect(describeEdgeMagnitude(null)).toBe(null);
      });

      test('undefined → null (safe return)', () => {
        expect(describeEdgeMagnitude(undefined)).toBe(null);
      });

      test('Infinity → null (non-finite)', () => {
        expect(describeEdgeMagnitude(Infinity)).toBe(null);
      });

      test('-Infinity → null (non-finite)', () => {
        expect(describeEdgeMagnitude(-Infinity)).toBe(null);
      });
    });
  });

  describe('classifyNhlSogTier', () => {
    describe('HOT tier (>= 0.8 shots AND confidence >= 0.5)', () => {
      test('(0.8, 0.5) → HOT (boundary case)', () => {
        expect(classifyNhlSogTier(0.8, 0.5)).toBe('HOT');
      });

      test('(0.8, 0.6) → HOT (strong confidence)', () => {
        expect(classifyNhlSogTier(0.8, 0.6)).toBe('HOT');
      });

      test('(1.0, 0.5) → HOT (well above edge threshold)', () => {
        expect(classifyNhlSogTier(1.0, 0.5)).toBe('HOT');
      });

      test('negative -0.8 uses absolute → HOT', () => {
        expect(classifyNhlSogTier(-0.8, 0.5)).toBe('HOT');
      });
    });

    describe('WATCH tier (>= 0.5 shots AND confidence >= 0.5)', () => {
      test('(0.5, 0.5) → WATCH (boundary case)', () => {
        expect(classifyNhlSogTier(0.5, 0.5)).toBe('WATCH');
      });

      test('(0.6, 0.5) → WATCH', () => {
        expect(classifyNhlSogTier(0.6, 0.5)).toBe('WATCH');
      });

      test('(0.7, 0.8) → WATCH (below HOT, above WATCH min)', () => {
        expect(classifyNhlSogTier(0.7, 0.8)).toBe('WATCH');
      });

      test('negative -0.5 uses absolute → WATCH', () => {
        expect(classifyNhlSogTier(-0.5, 0.5)).toBe('WATCH');
      });
    });

    describe('COLD tier (< 0.5 shots OR confidence < 0.5)', () => {
      test('(0.49, 0.8) → COLD (below watch min)', () => {
        expect(classifyNhlSogTier(0.49, 0.8)).toBe('COLD');
      });

      test('(0.1, 0.5) → COLD (edge below watch min)', () => {
        expect(classifyNhlSogTier(0.1, 0.5)).toBe('COLD');
      });

      test('(0.9, 0.49) → COLD (confidence gate blocks HOT)', () => {
        expect(classifyNhlSogTier(0.9, 0.49)).toBe('COLD');
      });

      test('(0.8, 0.49) → COLD (confidence just below 0.5)', () => {
        expect(classifyNhlSogTier(0.8, 0.49)).toBe('COLD');
      });

      test('(0.8, 0.0) → COLD (zero confidence)', () => {
        expect(classifyNhlSogTier(0.8, 0.0)).toBe('COLD');
      });

      test('(0.8, -0.1) → COLD (negative confidence)', () => {
        expect(classifyNhlSogTier(0.8, -0.1)).toBe('COLD');
      });
    });

    describe('edge cases', () => {
      test('NaN edge → COLD (non-finite)', () => {
        expect(classifyNhlSogTier(NaN, 0.5)).toBe('COLD');
      });

      test('NaN confidence → COLD (non-finite)', () => {
        expect(classifyNhlSogTier(0.8, NaN)).toBe('COLD');
      });

      test('null edge → COLD (non-finite)', () => {
        expect(classifyNhlSogTier(null, 0.5)).toBe('COLD');
      });

      test('null confidence → COLD (non-finite)', () => {
        expect(classifyNhlSogTier(0.8, null)).toBe('COLD');
      });

      test('Infinity edge → COLD (non-finite)', () => {
        expect(classifyNhlSogTier(Infinity, 0.5)).toBe('COLD');
      });
    });

    describe('regression: precision fixes', () => {
      test('(0.799999999, 0.5) → HOT after normalization (0.8)', () => {
        // 0.799999999 rounds to 0.8, which is >= 0.8 (HOT threshold)
        expect(classifyNhlSogTier(0.799999999, 0.5)).toBe('HOT');
      });

      test('(0.5000001, 0.5) → WATCH after normalization', () => {
        expect(classifyNhlSogTier(0.5000001, 0.5)).toBe('WATCH');
      });
    });
  });

  describe('EDGE_MAGNITUDE_TIERS constant', () => {
    test('has discord bands', () => {
      expect(EDGE_MAGNITUDE_TIERS.discord.strong_min).toBe(0.2);
      expect(EDGE_MAGNITUDE_TIERS.discord.thin_min).toBe(0.05);
    });

    test('has nhl_shots bands', () => {
      expect(EDGE_MAGNITUDE_TIERS.nhl_shots.hot_min).toBe(0.8);
      expect(EDGE_MAGNITUDE_TIERS.nhl_shots.watch_min).toBe(0.5);
    });

    test('is deeply frozen (immutable)', () => {
      expect(Object.isFrozen(EDGE_MAGNITUDE_TIERS)).toBe(true);
      expect(Object.isFrozen(EDGE_MAGNITUDE_TIERS.discord)).toBe(true);
      expect(Object.isFrozen(EDGE_MAGNITUDE_TIERS.nhl_shots)).toBe(true);
    });

    test('attempting to mutate fails silently (object already frozen)', () => {
      // This should fail silently because the object is frozen
      EDGE_MAGNITUDE_TIERS.discord.strong_min = 0.25;
      expect(EDGE_MAGNITUDE_TIERS.discord.strong_min).toBe(0.2); // Value unchanged
    });
  });

  describe('integration: Discord display labels with precision fix', () => {
    test('real case: 0.200000001 edge displays as strong (above threshold)', () => {
      // Value slightly above 0.2 should be strong
      const edgeBand = describeEdgeMagnitude(0.200000001);
      expect(edgeBand).toBe('strong');
    });

    test('real case: 0.199999999 edge displays as strong after normalization', () => {
      // This is the actual Discord bug that was reported
      // 0.199999999 normalizes to 0.2 via toFixed(4)
      const edgeBand = describeEdgeMagnitude(0.199999999);
      expect(edgeBand).toBe('strong');
    });

    test('real case: +0.07 edge displays as thin', () => {
      const edgeBand = describeEdgeMagnitude(0.07);
      expect(edgeBand).toBe('thin');
    });
  });

  describe('integration: NHL SOG with confidence gates', () => {
    test('McDavid-like scenario: 0.5 SOG edge, 0.65 confidence → WATCH', () => {
      const tier = classifyNhlSogTier(0.5, 0.65);
      expect(tier).toBe('WATCH');
    });

    test('strong model signal: 0.9 SOG edge, 0.8 confidence → HOT', () => {
      const tier = classifyNhlSogTier(0.9, 0.8);
      expect(tier).toBe('HOT');
    });

    test('noisy signal: 1.5 SOG edge, 0.3 confidence → COLD (confidence gate)', () => {
      const tier = classifyNhlSogTier(1.5, 0.3);
      expect(tier).toBe('COLD');
    });
  });
});
