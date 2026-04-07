'use strict';

const {
  classifyModelStatus,
  buildNoBetResult,
  DEGRADED_CONSTRAINTS,
} = require('../input-gate');

describe('classifyModelStatus', () => {
  describe('MODEL_OK', () => {
    it('returns MODEL_OK when all required keys are present', () => {
      const result = classifyModelStatus({ a: 1, b: 2, c: 3 }, ['a', 'b', 'c']);
      expect(result.status).toBe('MODEL_OK');
      expect(result.missingCritical).toEqual([]);
      expect(result.missingOptional).toEqual([]);
    });

    it('returns MODEL_OK when required present and no optional list provided', () => {
      const result = classifyModelStatus({ x: 100 }, ['x']);
      expect(result.status).toBe('MODEL_OK');
    });

    it('returns MODEL_OK when all required AND all optional keys present', () => {
      const result = classifyModelStatus({ a: 1, b: 2 }, ['a'], ['b']);
      expect(result.status).toBe('MODEL_OK');
      expect(result.missingOptional).toEqual([]);
    });

    it('returns MODEL_OK when required list is empty', () => {
      const result = classifyModelStatus({}, []);
      expect(result.status).toBe('MODEL_OK');
    });

    it('returns MODEL_OK with zero and false as valid values (falsy but not null/NaN)', () => {
      const result = classifyModelStatus({ a: 0, b: false }, ['a', 'b']);
      expect(result.status).toBe('MODEL_OK');
    });
  });

  describe('NO_BET', () => {
    it('returns NO_BET when one required key is null', () => {
      const result = classifyModelStatus({ a: 1, b: null }, ['a', 'b']);
      expect(result.status).toBe('NO_BET');
      expect(result.missingCritical).toContain('b');
    });

    it('returns NO_BET when one required key is undefined', () => {
      const result = classifyModelStatus({ a: 1 }, ['a', 'b']);
      expect(result.status).toBe('NO_BET');
      expect(result.missingCritical).toContain('b');
    });

    it('returns NO_BET when one required key is NaN', () => {
      const result = classifyModelStatus({ a: 1, b: NaN }, ['a', 'b']);
      expect(result.status).toBe('NO_BET');
      expect(result.missingCritical).toContain('b');
    });

    it('reports all missing keys when multiple required keys are null or NaN', () => {
      const result = classifyModelStatus({ a: null, b: NaN, c: 1 }, ['a', 'b', 'c']);
      expect(result.status).toBe('NO_BET');
      expect(result.missingCritical).toContain('a');
      expect(result.missingCritical).toContain('b');
      expect(result.missingCritical).not.toContain('c');
    });

    it('asymmetric team failure: home present, away null → NO_BET', () => {
      const result = classifyModelStatus(
        {
          home_starter_skill_ra9: 3.8,
          away_starter_skill_ra9: null,
        },
        ['home_starter_skill_ra9', 'away_starter_skill_ra9'],
      );
      expect(result.status).toBe('NO_BET');
      expect(result.missingCritical).toEqual(['away_starter_skill_ra9']);
    });
  });

  describe('DEGRADED', () => {
    it('returns DEGRADED when all required present but one optional is null', () => {
      const result = classifyModelStatus({ a: 1 }, ['a'], ['b']);
      expect(result.status).toBe('DEGRADED');
      expect(result.missingCritical).toEqual([]);
      expect(result.missingOptional).toContain('b');
    });

    it('returns DEGRADED when all required present and multiple optional missing', () => {
      const result = classifyModelStatus({ a: 1 }, ['a'], ['b', 'c']);
      expect(result.status).toBe('DEGRADED');
      expect(result.missingOptional).toEqual(['b', 'c']);
    });

    it('DEGRADED takes precedence over MODEL_OK when optional is NaN', () => {
      const result = classifyModelStatus({ a: 5, opt: NaN }, ['a'], ['opt']);
      expect(result.status).toBe('DEGRADED');
    });

    it('NO_BET takes precedence over DEGRADED when required is also null', () => {
      const result = classifyModelStatus({ req: null }, ['req'], ['opt']);
      expect(result.status).toBe('NO_BET');
    });
  });
});

describe('buildNoBetResult', () => {
  it('returns canonical envelope with status NO_BET and zero confidence', () => {
    const result = buildNoBetResult(['k_per_9']);
    expect(result.status).toBe('NO_BET');
    expect(result.confidence).toBe(0);
    expect(result.projection).toBeNull();
    expect(result.prediction).toBeNull();
    expect(result.reason).toBe('MISSING_CORE_INPUTS');
  });

  it('preserves missingCritical array in output', () => {
    const missing = ['homePace', 'awayPace'];
    const result = buildNoBetResult(missing);
    expect(result.missingCritical).toEqual(missing);
  });

  it('merges context fields into envelope', () => {
    const result = buildNoBetResult([], { projection_source: 'NO_BET', sport: 'nba' });
    expect(result.projection_source).toBe('NO_BET');
    expect(result.sport).toBe('nba');
  });

  it('context fields spread last — callers must not pass status/confidence/reason', () => {
    // Per the implementation: ...context is spread last, so it wins on collision.
    // This is the actual behavior — callers are responsible not to pass reserved fields.
    const result = buildNoBetResult([], { projection_source: 'NO_BET', sport: 'mlb' });
    expect(result.status).toBe('NO_BET');
    expect(result.confidence).toBe(0);
    expect(result.sport).toBe('mlb');
  });

  it('returns empty missingCritical when none provided', () => {
    const result = buildNoBetResult([]);
    expect(result.missingCritical).toEqual([]);
  });
});

describe('DEGRADED_CONSTRAINTS', () => {
  it('MAX_CONFIDENCE is 0.55', () => {
    expect(DEGRADED_CONSTRAINTS.MAX_CONFIDENCE).toBe(0.55);
  });

  it('FORBIDDEN_TIERS includes PLAY', () => {
    expect(DEGRADED_CONSTRAINTS.FORBIDDEN_TIERS).toContain('PLAY');
  });

  it('object is frozen', () => {
    expect(Object.isFrozen(DEGRADED_CONSTRAINTS)).toBe(true);
  });

  it('FORBIDDEN_TIERS array itself is frozen', () => {
    expect(Object.isFrozen(DEGRADED_CONSTRAINTS.FORBIDDEN_TIERS)).toBe(true);
  });
});
