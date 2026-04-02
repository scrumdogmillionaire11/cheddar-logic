/**
 * Unit tests for season date logic in config.js
 *
 * Tests the wrap-around (NFL Sep–Feb) vs within-year (MLB Mar–Nov) fix.
 * Date injection is done by overriding Date globally per test.
 */

const { getActiveSports, isInSeason, SPORTS_CONFIG } = require('../config.js');

// Helper: mock today's date to a fixed mmdd string, e.g. '01-15' for Jan 15
function withDate(mmdd, fn) {
  const [month, day] = mmdd.split('-').map(Number);
  const RealDate = global.Date;
  class MockDate extends RealDate {
    constructor(...args) {
      if (args.length === 0) {
        super(2026, month - 1, day); // month is 0-indexed in JS Date
      } else {
        super(...args);
      }
    }
    static now() {
      return new MockDate().getTime();
    }
  }
  global.Date = MockDate;
  try {
    return fn();
  } finally {
    global.Date = RealDate;
  }
}

// Convenience: temporarily flip an active flag so we can test in-season logic
function withActive(sport, active, fn) {
  const original = SPORTS_CONFIG[sport].active;
  SPORTS_CONFIG[sport].active = active;
  try {
    return fn();
  } finally {
    SPORTS_CONFIG[sport].active = original;
  }
}

// ─── MLB (within-year: Mar 20 – Nov 1) ───────────────────────────────────────

describe('MLB season logic (within-year: 03-20 to 11-01)', () => {
  beforeEach(() => {
    // Ensure MLB is active for all season tests
    SPORTS_CONFIG.MLB.active = true;
  });

  afterEach(() => {
    SPORTS_CONFIG.MLB.active = true; // keep active for other tests
  });

  test('January 15 — NOT in season', () => {
    withDate('01-15', () => {
      expect(isInSeason('MLB')).toBe(false);
    });
  });

  test('February 20 — NOT in season', () => {
    withDate('02-20', () => {
      expect(isInSeason('MLB')).toBe(false);
    });
  });

  test('March 19 (day before start) — NOT in season', () => {
    withDate('03-19', () => {
      expect(isInSeason('MLB')).toBe(false);
    });
  });

  test('March 20 (first day) — in season', () => {
    withDate('03-20', () => {
      expect(isInSeason('MLB')).toBe(true);
    });
  });

  test('April 1 — in season', () => {
    withDate('04-01', () => {
      expect(isInSeason('MLB')).toBe(true);
    });
  });

  test('October 31 — in season', () => {
    withDate('10-31', () => {
      expect(isInSeason('MLB')).toBe(true);
    });
  });

  test('November 1 (last day) — in season', () => {
    withDate('11-01', () => {
      expect(isInSeason('MLB')).toBe(true);
    });
  });

  test('November 15 — NOT in season', () => {
    withDate('11-15', () => {
      expect(isInSeason('MLB')).toBe(false);
    });
  });

  test('December 25 — NOT in season', () => {
    withDate('12-25', () => {
      expect(isInSeason('MLB')).toBe(false);
    });
  });
});

// ─── NFL (wrap-around: Sep 1 – Feb 15) ───────────────────────────────────────

describe('NFL season logic (wrap-around: 09-01 to 02-15)', () => {
  // NFL active=false in production; force active for these season tests
  beforeEach(() => {
    SPORTS_CONFIG.NFL.active = true;
  });
  afterEach(() => {
    SPORTS_CONFIG.NFL.active = false;
  });

  test('January 15 — in season (AFC/NFC playoffs)', () => {
    withDate('01-15', () => {
      expect(isInSeason('NFL')).toBe(true);
    });
  });

  test('February 15 (last day) — in season (Super Bowl window)', () => {
    withDate('02-15', () => {
      expect(isInSeason('NFL')).toBe(true);
    });
  });

  test('February 16 (one day after end) — NOT in season', () => {
    withDate('02-16', () => {
      expect(isInSeason('NFL')).toBe(false);
    });
  });

  test('April 1 — NOT in season (offseason)', () => {
    withDate('04-01', () => {
      expect(isInSeason('NFL')).toBe(false);
    });
  });

  test('July 4 — NOT in season', () => {
    withDate('07-04', () => {
      expect(isInSeason('NFL')).toBe(false);
    });
  });

  test('September 1 (first day) — in season', () => {
    withDate('09-01', () => {
      expect(isInSeason('NFL')).toBe(true);
    });
  });

  test('December 25 — in season', () => {
    withDate('12-25', () => {
      expect(isInSeason('NFL')).toBe(true);
    });
  });
});

// ─── NHL (wrap-around: Oct 1 – Apr 30) ───────────────────────────────────────

describe('NHL season logic (wrap-around: 10-01 to 04-30)', () => {
  beforeEach(() => {
    SPORTS_CONFIG.NHL.active = true;
  });
  afterEach(() => {
    SPORTS_CONFIG.NHL.active = true;
  });

  test('January 15 — in season', () => {
    withDate('01-15', () => {
      expect(isInSeason('NHL')).toBe(true);
    });
  });

  test('July 4 — NOT in season', () => {
    withDate('07-04', () => {
      expect(isInSeason('NHL')).toBe(false);
    });
  });
});

// ─── getActiveSports() integration ───────────────────────────────────────────

describe('getActiveSports() reflects correct season logic', () => {
  beforeEach(() => {
    // Force all four sports active so we can observe season filtering
    SPORTS_CONFIG.MLB.active = true;
    SPORTS_CONFIG.NFL.active = true;
    SPORTS_CONFIG.NHL.active = true;
    SPORTS_CONFIG.NBA.active = true;
  });

  afterEach(() => {
    SPORTS_CONFIG.MLB.active = true;
    SPORTS_CONFIG.NFL.active = false; // restore production default
    SPORTS_CONFIG.NHL.active = true;
    SPORTS_CONFIG.NBA.active = true;
  });

  test('January 15 — NFL + NHL + NBA active; MLB NOT active', () => {
    const result = withDate('01-15', () => getActiveSports());
    expect(result).toContain('NFL');
    expect(result).toContain('NHL');
    expect(result).toContain('NBA');
    expect(result).not.toContain('MLB');
  });

  test('February 20 — NHL + NBA active; MLB NOT active; NFL NOT active (past Feb 15 end)', () => {
    const result = withDate('02-20', () => getActiveSports());
    expect(result).not.toContain('MLB');
    expect(result).not.toContain('NFL'); // NFL season ends Feb 15
    expect(result).toContain('NHL');
    expect(result).toContain('NBA');
  });

  test('April 1 — MLB + NHL + NBA active; NFL NOT active', () => {
    const result = withDate('04-01', () => getActiveSports());
    expect(result).toContain('MLB');
    expect(result).not.toContain('NFL');
  });

  test('November 15 — MLB NOT active; NHL + NBA active; NFL active', () => {
    const result = withDate('11-15', () => getActiveSports());
    expect(result).not.toContain('MLB');
    expect(result).toContain('NFL');
    expect(result).toContain('NHL');
  });

  test('July 4 — MLB active; NHL/NFL/NBA NOT active', () => {
    const result = withDate('07-04', () => getActiveSports());
    expect(result).toContain('MLB');
    expect(result).not.toContain('NHL');
    expect(result).not.toContain('NFL');
    expect(result).not.toContain('NBA');
  });
});

// ─── active=false suppresses even in-season sports ───────────────────────────

describe('active flag suppresses even in-season results', () => {
  test('MLB active=false returns false in April', () => {
    withActive('MLB', false, () => {
      withDate('04-01', () => {
        expect(isInSeason('MLB')).toBe(false);
      });
    });
  });

  test('MLB active=false excluded from getActiveSports in April', () => {
    withActive('MLB', false, () => {
      const result = withDate('04-01', () => getActiveSports());
      expect(result).not.toContain('MLB');
    });
  });
});
