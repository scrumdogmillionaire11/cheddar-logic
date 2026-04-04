'use strict';

/**
 * Tests for packages/adapters/src/vsin.js
 *
 * Fixture: packages/adapters/fixtures/vsin/splits.real-capture.json
 * Status:  REAL_CAPTURE — captured from data.vsin.com on 2026-04-03
 *
 * Tests cover:
 *   1. Unit tests for helper functions (_parsePct, _parseLine, _validatePctSum, etc.)
 *   2. parseSplitsHtml against real HTML row fixtures (NBA, MLB, NHL)
 *   3. Edge cases: insufficient cells, wrong row count, arrow entities
 *   4. fetchSplitsHtml: BAD_SOURCE enforcement
 */

const path = require('path');
const {
  parseSplitsHtml,
  fetchSplitsHtml,
  _parsePct,
  _parseLine,
  _validatePctSum,
  _extractBadgeText,
  _extractCells,
  _isAwayRow,
  _extractTeamName,
  _extractGamecode,
  _buildMarketSplit,
  _VALID_SOURCES,
} = require('../vsin');

const FIXTURE = require('../../fixtures/vsin/splits.real-capture.json');

// ─── Helper functions ────────────────────────────────────────────────────────

describe('_parsePct', () => {
  it('parses clean integer percentage', () => expect(_parsePct('59%')).toBe(59));
  it('parses percentage with trailing space', () => expect(_parsePct('41% ')).toBe(41));
  it('parses percentage with arrow entity stripped', () => expect(_parsePct('59% ▲')).toBe(59));
  it('parses float percentage', () => expect(_parsePct('45.5%')).toBe(45.5));
  it('returns null for null', () => expect(_parsePct(null)).toBeNull());
  it('returns null for empty string', () => expect(_parsePct('')).toBeNull());
  it('returns null for >100', () => expect(_parsePct('101%')).toBeNull());
  it('returns null for negative', () => expect(_parsePct('-5%')).toBeNull());
  it('returns 0 for "0%"', () => expect(_parsePct('0%')).toBe(0));
  it('returns 100 for "100%"', () => expect(_parsePct('100%')).toBe(100));
});

describe('_parseLine', () => {
  it('parses positive integer', () => expect(_parseLine('+142')).toBe(142));
  it('parses negative integer', () => expect(_parseLine('-170')).toBe(-170));
  it('parses positive decimal spread', () => expect(_parseLine('+3.5')).toBe(3.5));
  it('parses negative decimal spread', () => expect(_parseLine('-3.5')).toBe(-3.5));
  it('parses total (no sign)', () => expect(_parseLine('233.5')).toBe(233.5));
  it('returns null for null', () => expect(_parseLine(null)).toBeNull());
  it('returns null for empty', () => expect(_parseLine('')).toBeNull());
  it('returns null for non-numeric', () => expect(_parseLine('PK')).toBeNull());
});

describe('_validatePctSum', () => {
  it('valid: both null', () => expect(_validatePctSum(null, null, 'x').valid).toBe(true));
  it('valid: sums to 100', () => expect(_validatePctSum(59, 41, 'x').valid).toBe(true));
  it('valid: sums to 99 (rounding)', () => expect(_validatePctSum(50, 49, 'x').valid).toBe(true));
  it('valid: sums to 101 (rounding)', () => expect(_validatePctSum(51, 50, 'x').valid).toBe(true));
  it('invalid: asymmetric (one null)', () => {
    const r = _validatePctSum(59, null, 'x');
    expect(r.valid).toBe(false);
    expect(r.reason).toContain('asymmetric');
  });
  it('invalid: sum too low', () => {
    const r = _validatePctSum(40, 30, 'x');
    expect(r.valid).toBe(false);
    expect(r.reason).toContain('outside');
  });
  it('invalid: sum too high', () => {
    const r = _validatePctSum(60, 60, 'x');
    expect(r.valid).toBe(false);
    expect(r.reason).toContain('outside');
  });
});

describe('_extractBadgeText', () => {
  it('extracts plain badge text', () => {
    const html = '<td><span class="sp-badge">59%</span></td>';
    expect(_extractBadgeText(html)).toBe('59%');
  });
  it('extracts badge text with nested arrow span', () => {
    const html = '<td><span class="sp-badge">41% <span class="sp-arrow-dn">&#9660;</span></span></td>';
    expect(_extractBadgeText(html)).toBe('41%');
  });
  it('extracts badge-line variant', () => {
    const html = '<td class="sp-col-first"><span class="sp-badge sp-badge-line">+3.5</span></td>';
    expect(_extractBadgeText(html)).toBe('+3.5');
  });
  it('returns null for cell with no badge', () => {
    const html = '<td class="sp-cell-action"><button>x</button></td>';
    expect(_extractBadgeText(html)).toBeNull();
  });
});

describe('_isAwayRow', () => {
  it('returns true for away row (sp-act-history button)', () => {
    const html = '<tr><td><button class="sp-act-history" data-gamecode="x">&#8634;</button></td></tr>';
    expect(_isAwayRow(html)).toBe(true);
  });
  it('returns false for home row (sp-act-count button)', () => {
    const html = '<tr><td><button class="sp-act-count" data-gamecode="x">3</button></td></tr>';
    expect(_isAwayRow(html)).toBe(false);
  });
});

describe('_extractTeamName', () => {
  it('extracts team full name from anchor', () => {
    const html = '<a class="sp-team-link" href="/nba/teams/timberwolves">Minnesota Timberwolves</a>';
    expect(_extractTeamName(html)).toBe('Minnesota Timberwolves');
  });
  it('returns null when anchor absent', () => {
    expect(_extractTeamName('<td><span>test</span></td>')).toBeNull();
  });
});

describe('_extractGamecode', () => {
  it('extracts gamecode from row', () => {
    const html = '<button data-gamecode="20260403NBA00083">&#8634;</button>';
    expect(_extractGamecode(html)).toBe('20260403NBA00083');
  });
  it('returns null when absent', () => {
    expect(_extractGamecode('<td>no code here</td>')).toBeNull();
  });
});

// ─── parseSplitsHtml unit: empty/invalid inputs ──────────────────────────────

describe('parseSplitsHtml — edge cases', () => {
  it('returns [] for empty html', () => expect(parseSplitsHtml('', 'DK')).toEqual([]));
  it('returns [] for null html', () => expect(parseSplitsHtml(null, 'DK')).toEqual([]));
  it('returns [] for html with no table rows', () => {
    expect(parseSplitsHtml('<html><body>No rows</body></html>', 'DK')).toEqual([]);
  });
  it('does not throw on malformed html', () => {
    expect(() => parseSplitsHtml('<tr><td><tr><td></td>', 'DK')).not.toThrow();
  });
});

// ─── parseSplitsHtml: fixture-driven real data tests ─────────────────────────

/**
 * Reconstruct a 2-row HTML fragment for a gamecode from fixture data.
 * Wraps rows in a basic <table><tbody>...</tbody></table>.
 */
function buildHtmlFromFixture(source, gamecode) {
  const sourceData = FIXTURE[source.toLowerCase()];
  if (!sourceData) throw new Error(`Fixture has no source "${source}"`);
  const rows = sourceData[gamecode];
  if (!rows) throw new Error(`Fixture has no gamecode "${gamecode}" in source "${source}"`);
  return `<table><tbody>${rows.map((r) => `<tr>${r}</tr>`).join('\n')}</tbody></table>`;
}

const FIXTURE_GAMECODES = {
  NBA: '20260403NBA00083',
  MLB: '20260403MLB00018',
  NHL: '20260403NHL00094',
};

const SOURCES = ['dk', 'circa'];

for (const source of SOURCES) {
  describe(`parseSplitsHtml — real fixture (source=${source.toUpperCase()})`, () => {
    for (const [sport, gamecode] of Object.entries(FIXTURE_GAMECODES)) {
      describe(`${sport} game ${gamecode}`, () => {
        let games;

        beforeAll(() => {
          const html = buildHtmlFromFixture(source, gamecode);
          games = parseSplitsHtml(html, source.toUpperCase());
        });

        it('parses exactly 1 game', () => {
          expect(games).toHaveLength(1);
        });

        it('game has correct gamecode', () => {
          expect(games[0].gamecode).toBe(gamecode);
        });

        it('game has correct sport', () => {
          expect(games[0].sport).toBe(sport);
        });

        it('game has away and home team names', () => {
          expect(typeof games[0].awayTeam).toBe('string');
          expect(games[0].awayTeam.length).toBeGreaterThan(0);
          expect(typeof games[0].homeTeam).toBe('string');
          expect(games[0].homeTeam.length).toBeGreaterThan(0);
        });

        it('away and home teams are different', () => {
          expect(games[0].awayTeam).not.toBe(games[0].homeTeam);
        });

        it('has 3 market splits (SPREAD, TOTAL, ML)', () => {
          expect(games[0].markets).toHaveLength(3);
          const types = games[0].markets.map((m) => m.marketType);
          expect(types).toContain('SPREAD');
          expect(types).toContain('TOTAL');
          expect(types).toContain('ML');
        });

        it('all markets from live fixture are valid', () => {
          for (const m of games[0].markets) {
            expect(m.valid).toBe(true);
          }
        });

        it('SPREAD market has numeric line', () => {
          const spread = games[0].markets.find((m) => m.marketType === 'SPREAD');
          expect(typeof spread.line).toBe('number');
          expect(isFinite(spread.line)).toBe(true);
        });

        it('TOTAL market has numeric line', () => {
          const total = games[0].markets.find((m) => m.marketType === 'TOTAL');
          expect(typeof total.line).toBe('number');
          expect(total.line).toBeGreaterThan(0);
        });

        it('TOTAL market selectionScope is OVER_UNDER', () => {
          const total = games[0].markets.find((m) => m.marketType === 'TOTAL');
          expect(total.selectionScope).toBe('OVER_UNDER');
        });

        it('SPREAD/ML selectionScope is HOME_AWAY', () => {
          for (const m of games[0].markets.filter((m) => m.marketType !== 'TOTAL')) {
            expect(m.selectionScope).toBe('HOME_AWAY');
          }
        });

        it('valid markets have numeric bets percentages', () => {
          for (const m of games[0].markets.filter((m) => m.valid)) {
            expect(typeof m.away_or_over_bets_pct).toBe('number');
            expect(typeof m.home_or_under_bets_pct).toBe('number');
          }
        });

        it('bets percentages sum to ~100 for valid markets', () => {
          for (const m of games[0].markets.filter((m) => m.valid)) {
            if (m.away_or_over_bets_pct != null && m.home_or_under_bets_pct != null) {
              const sum = m.away_or_over_bets_pct + m.home_or_under_bets_pct;
              expect(sum).toBeGreaterThanOrEqual(96);
              expect(sum).toBeLessThanOrEqual(104);
            }
          }
        });

        it('source field matches requested source', () => {
          for (const m of games[0].markets) {
            expect(m.source).toBe(source.toUpperCase());
          }
        });
      });
    }
  });
}

// ─── fetchSplitsHtml: BAD_SOURCE guard ───────────────────────────────────────

describe('fetchSplitsHtml', () => {
  it('VALID_SOURCES contains DK and CIRCA', () => {
    expect(_VALID_SOURCES).toContain('DK');
    expect(_VALID_SOURCES).toContain('CIRCA');
  });

  it('returns BAD_SOURCE for unknown source without making a network call', async () => {
    const result = await fetchSplitsHtml({ source: 'UNKNOWN_BOOK' });
    expect(result.sourceStatus).toBe('BAD_SOURCE');
    expect(result.html).toBe('');
    expect(result.error).toContain('UNKNOWN_BOOK');
  });

  it('returns BAD_SOURCE for empty string source', async () => {
    const result = await fetchSplitsHtml({ source: '' });
    expect(result.sourceStatus).toBe('BAD_SOURCE');
  });

  it('returns BAD_SOURCE for lowercase source', async () => {
    const result = await fetchSplitsHtml({ source: 'dk' });
    expect(result.sourceStatus).toBe('BAD_SOURCE');
  });
});

// ─── Cross-source comparison ─────────────────────────────────────────────────

describe('DK vs CIRCA fixture comparison', () => {
  it('same gamecodes appear in both sources', () => {
    const dkCodes = Object.keys(FIXTURE.dk);
    const circaCodes = Object.keys(FIXTURE.circa);
    for (const gc of dkCodes) {
      expect(circaCodes).toContain(gc);
    }
  });

  it('DK and CIRCA may return different percentages for same game', () => {
    // Not guaranteed, but ensures we're not just copying the same array
    // We just verify both parse without error here (pcts will differ if sharp vs. public)
    const gc = FIXTURE_GAMECODES.NBA;
    const dkHtml = buildHtmlFromFixture('dk', gc);
    const circaHtml = buildHtmlFromFixture('circa', gc);
    const dkGames = parseSplitsHtml(dkHtml, 'DK');
    const circaGames = parseSplitsHtml(circaHtml, 'CIRCA');
    expect(dkGames).toHaveLength(1);
    expect(circaGames).toHaveLength(1);
    expect(dkGames[0].markets[0].source).toBe('DK');
    expect(circaGames[0].markets[0].source).toBe('CIRCA');
  });
});
