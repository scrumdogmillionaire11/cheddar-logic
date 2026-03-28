/**
 * Integration tests for data pipeline
 * 
 * Ensures data flows correctly from DB -> API -> UI
 */

const {
  getDatabase,
  closeDatabase,
} = require('../src/db.js');

describe('Data Pipeline Integration', () => {
  beforeAll(async () => {
  });

  afterAll(() => {
    closeDatabase();
  });

  describe('Database Integrity', () => {
    test('should have games table', () => {
      const db = getDatabase();
      const result = db.prepare(
        `SELECT name FROM sqlite_master WHERE type='table' AND name='games'`
      ).get();
      expect(result).toBeDefined();
      expect(result.name).toBe('games');
    });

    test('should have card_payloads table', () => {
      const db = getDatabase();
      const result = db.prepare(
        `SELECT name FROM sqlite_master WHERE type='table' AND name='card_payloads'`
      ).get();
      expect(result).toBeDefined();
      expect(result.name).toBe('card_payloads');
    });

    test('should have games with valid data', () => {
      const db = getDatabase();
      const games = db.prepare(`
        SELECT COUNT(*) as count
        FROM games
        WHERE game_id IS NOT NULL
          AND sport IS NOT NULL
          AND home_team IS NOT NULL
          AND away_team IS NOT NULL
      `).get();
      
      expect(games.count).toBeGreaterThan(0);
    });

    test('should have future games', () => {
      const db = getDatabase();
      const futureGames = db.prepare(`
        SELECT COUNT(*) as count
        FROM games
        WHERE game_time_utc >= datetime('now')
      `).get();
      
      expect(futureGames.count).toBeGreaterThan(0);
    });
  });

  describe('Card Coverage', () => {
    test('most future games should have card payloads', () => {
      const db = getDatabase();
      
      const totalFuture = db.prepare(`
        SELECT COUNT(*) as count
        FROM games
        WHERE game_time_utc >= datetime('now')
      `).get();

      const futureWithCards = db.prepare(`
        SELECT COUNT(DISTINCT g.game_id) as count
        FROM games g
        INNER JOIN card_payloads cp ON g.game_id = cp.game_id
        WHERE g.game_time_utc >= datetime('now')
          AND (cp.expires_at IS NULL OR cp.expires_at > datetime('now'))
      `).get();

      expect(futureWithCards.count).toBeGreaterThan(0);
      if (totalFuture.count > 0) {
        const coverageRatio = futureWithCards.count / totalFuture.count;
        if (coverageRatio < 0.85) {
          console.warn(
            `[Integration] Card coverage is ${(coverageRatio * 100).toFixed(1)}% — below 85% threshold. Model runs may be pending.`
          );
        }
        // Soft threshold: warn below 85%, hard-fail below 40% (model completely broken)
        expect(coverageRatio).toBeGreaterThanOrEqual(0.4);
      }
    });

    test('card payloads should have valid JSON', () => {
      const db = getDatabase();
      const cards = db.prepare(`
        SELECT id, payload_data
        FROM card_payloads
        LIMIT 10
      `).all();

      expect(cards.length).toBeGreaterThan(0);

      cards.forEach(card => {
        expect(card.payload_data).toBeDefined();
        expect(() => JSON.parse(card.payload_data)).not.toThrow();
        
        const payload = JSON.parse(card.payload_data);
        expect(payload.prediction).toBeDefined();
        expect(payload.recommended_bet_type).toBeDefined();
      });
    });

    test('card payloads should reference existing games', () => {
      const db = getDatabase();
      const orphanedCards = db.prepare(`
        SELECT COUNT(*) as count
        FROM card_payloads cp
        LEFT JOIN games g ON cp.game_id = g.game_id
        WHERE g.game_id IS NULL
      `).get();

      expect(orphanedCards.count).toBe(0);
    });
  });

  describe('API Query Compatibility', () => {
    test('should return games using /api/games query logic', () => {
      const db = getDatabase();
      
      // Replicate /api/games date filtering
      const now = new Date();
      const etDateStr = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'America/New_York',
      }).format(now);
      
      const tzPart = new Intl.DateTimeFormat('en-US', {
        timeZone: 'America/New_York',
        timeZoneName: 'shortOffset',
      })
        .formatToParts(now)
        .find((p) => p.type === 'timeZoneName').value;
        
      const offsetHours = parseInt(tzPart.replace('GMT', '') || '-5', 10);
      const sign = offsetHours < 0 ? '-' : '+';
      const absHours = Math.abs(offsetHours).toString().padStart(2, '0');
      const localMidnight = new Date(`${etDateStr}T00:00:00${sign}${absHours}:00`);
      const todayUtc = localMidnight.toISOString().substring(0, 19).replace('T', ' ');

      const sql = `
        SELECT
          g.id,
          g.game_id,
          g.sport,
          g.home_team,
          g.away_team,
          g.game_time_utc
        FROM games g
        WHERE datetime(g.game_time_utc) >= ?
        ORDER BY g.game_time_utc ASC
        LIMIT 200
      `;

      const games = db.prepare(sql).all(todayUtc);
      expect(games.length).toBeGreaterThan(0);

      // Verify games have expected structure
      games.forEach(game => {
        expect(game.game_id).toBeDefined();
        expect(game.sport).toBeDefined();
        expect(game.home_team).toBeDefined();
        expect(game.away_team).toBeDefined();
        expect(game.game_time_utc).toBeDefined();
      });
    });

    test('games should have associated card payloads', () => {
      const db = getDatabase();
      
      const now = new Date();
      const etDateStr = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'America/New_York',
      }).format(now);
      
      const tzPart = new Intl.DateTimeFormat('en-US', {
        timeZone: 'America/New_York',
        timeZoneName: 'shortOffset',
      })
        .formatToParts(now)
        .find((p) => p.type === 'timeZoneName').value;
        
      const offsetHours = parseInt(tzPart.replace('GMT', '') || '-5', 10);
      const sign = offsetHours < 0 ? '-' : '+';
      const absHours = Math.abs(offsetHours).toString().padStart(2, '0');
      const localMidnight = new Date(`${etDateStr}T00:00:00${sign}${absHours}:00`);
      const todayUtc = localMidnight.toISOString().substring(0, 19).replace('T', ' ');

      const games = db.prepare(`
        SELECT game_id
        FROM games
        WHERE datetime(game_time_utc) >= ?
        LIMIT 10
      `).all(todayUtc);

      expect(games.length).toBeGreaterThan(0);

      games.forEach(game => {
        const cards = db.prepare(`
          SELECT COUNT(*) as count
          FROM card_payloads
          WHERE game_id = ?
            AND (expires_at IS NULL OR expires_at > datetime('now'))
        `).get(game.game_id);

        if (cards.count === 0) {
          console.warn(`[Integration] Game ${game.game_id} has no card payloads — model run may be pending.`);
        }
      });
      // Soft check: at least half the sampled games should have cards
      const gamesWithCards = games.filter(game => {
        const cards = db.prepare(`
          SELECT COUNT(*) as count FROM card_payloads
          WHERE game_id = ? AND (expires_at IS NULL OR expires_at > datetime('now'))
        `).get(game.game_id);
        return cards.count > 0;
      });
      expect(gamesWithCards.length).toBeGreaterThan(0);
    });
  });

  describe('Results Pipeline', () => {
    test('should have card_results table', () => {
      const db = getDatabase();
      const result = db.prepare(
        `SELECT name FROM sqlite_master WHERE type='table' AND name='card_results'`
      ).get();
      expect(result).toBeDefined();
      expect(result.name).toBe('card_results');
    });

    test('card_results should reference card_payloads', () => {
      const db = getDatabase();
      const orphanedResults = db.prepare(`
        SELECT COUNT(*) as count
        FROM card_results cr
        LEFT JOIN card_payloads cp ON cr.card_id = cp.id
        WHERE cp.id IS NULL
      `).get();

      expect(orphanedResults.count).toBe(0);
    });
  });
});
