/**
 * Database Security Audit Script
 *
 * This script audits all SQL queries in the API endpoints for SQL injection vulnerabilities.
 * Run via: npx tsx src/lib/api-security/audit-database.ts
 */

import { auditSQLQuery, generateAuditReport } from './sql-audit';

// All SQL queries extracted from the API endpoints
const QUERIES_TO_AUDIT = [
  {
    name: 'games: Check if games table exists',
    sql: `SELECT name FROM sqlite_master WHERE type='table' AND name='games'`,
    endpoint: '/api/games',
    parameterized: false,
  },
  {
    name: 'games: Main game list with odds',
    sql: `
      WITH latest_odds AS (
        SELECT *, ROW_NUMBER() OVER (PARTITION BY game_id ORDER BY captured_at DESC) AS rn
        FROM odds_snapshots
      )
      SELECT
        g.id,
        g.game_id,
        g.sport,
        g.home_team,
        g.away_team,
        g.game_time_utc,
        g.status,
        g.created_at,
        o.h2h_home,
        o.h2h_away,
        o.total,
        o.spread_home,
        o.spread_away,
        o.spread_price_home,
        o.spread_price_away,
        o.total_price_over,
        o.total_price_under,
        o.captured_at AS odds_captured_at
      FROM games g
      INNER JOIN latest_odds o ON o.game_id = g.game_id AND o.rn = 1
      WHERE datetime(g.game_time_utc) >= ?
      ORDER BY g.game_time_utc ASC
      LIMIT 200
    `,
    endpoint: '/api/games',
    parameterized: true,
    parameters: ['2026-03-03 00:00:00'],
  },
  {
    name: 'games: Card payloads for game IDs',
    sql: `
      SELECT
        id,
        game_id,
        sport,
        card_type,
        card_title,
        created_at,
        expires_at,
        payload_data
      FROM card_payloads
      WHERE game_id IN (?, ?, ?)
        AND (expires_at IS NULL OR datetime(expires_at) > datetime('now'))
      ORDER BY created_at DESC
    `,
    endpoint: '/api/games',
    parameterized: true,
    parameters: ['game1', 'game2', 'game3'],
  },
  {
    name: 'cards: Check if card_payloads table exists',
    sql: `SELECT name FROM sqlite_master WHERE type='table' AND name='card_payloads'`,
    endpoint: '/api/cards',
    parameterized: false,
  },
  {
    name: 'cards: Card list with deduplication',
    sql: `
      WITH ranked AS (
        SELECT *,
          ROW_NUMBER() OVER (
            PARTITION BY game_id, card_type
            ORDER BY created_at DESC
          ) AS rn
        FROM card_payloads
        WHERE sport = ? AND card_type = ? AND game_id = ?
          AND (expires_at IS NULL OR datetime(expires_at) > datetime('now'))
      )
      SELECT * FROM ranked
      WHERE rn = 1
      ORDER BY created_at DESC
      LIMIT ? OFFSET ?
    `,
    endpoint: '/api/cards',
    parameterized: true,
    parameters: ['NBA', 'spread-call', 'game123', 20, 0],
  },
  {
    name: 'results: Dedup SELECT for filtered cards',
    sql: `
      WITH filtered AS (
        SELECT cp.id
        FROM card_payloads cp
        LEFT JOIN card_results cr ON cp.id = cr.card_id
        WHERE cp.sport = ? AND cr.card_category = ?
      )
      SELECT DISTINCT cp.id
      FROM card_payloads cp
      WHERE cp.id IN (SELECT id FROM filtered)
      ORDER BY cp.id DESC
    `,
    endpoint: '/api/results',
    parameterized: true,
    parameters: ['NBA', 'driver'],
  },
  {
    name: 'results: Filtered count query',
    sql: `
      WITH filtered AS (
        SELECT cp.id
        FROM card_payloads cp
        LEFT JOIN card_results cr ON cp.id = cr.card_id
        WHERE cp.sport = ? AND cr.card_category = ?
      )
      SELECT COUNT(*) AS count
      FROM filtered
    `,
    endpoint: '/api/results',
    parameterized: true,
    parameters: ['NBA', 'driver'],
  },
  {
    name: 'results: Total settled cards count',
    sql: `SELECT COUNT(*) AS count FROM card_results WHERE status = 'settled'`,
    endpoint: '/api/results',
    parameterized: false,
  },
  {
    name: 'results: Orphaned settled cards count',
    sql: `
      SELECT COUNT(*) AS count
      FROM card_results cr
      LEFT JOIN card_payloads cp ON cr.card_id = cp.id
      WHERE cr.status = 'settled' AND cp.id IS NULL
    `,
    endpoint: '/api/results',
    parameterized: false,
  },
  {
    name: 'results: Summary aggregation',
    sql: `
      SELECT
        COUNT(*) AS total_cards,
        SUM(CASE WHEN cr.status = 'settled' THEN 1 ELSE 0 END) AS settled_cards,
        SUM(CASE WHEN cr.result = 'win' THEN 1 ELSE 0 END) AS wins,
        SUM(CASE WHEN cr.result = 'loss' THEN 1 ELSE 0 END) AS losses,
        SUM(CASE WHEN cr.result = 'push' THEN 1 ELSE 0 END) AS pushes,
        SUM(COALESCE(cr.pnl_units, 0)) AS total_pnl_units
      FROM card_results cr
      WHERE cr.id IN (?, ?, ?)
    `,
    endpoint: '/api/results',
    parameterized: true,
    parameters: ['id1', 'id2', 'id3'],
  },
  {
    name: 'results: Segments breakdown',
    sql: `
      SELECT
        cr.sport,
        CASE
          WHEN cr.card_type LIKE '%-totals-call' OR cr.card_type LIKE '%-spread-call'
            THEN 'call'
          ELSE 'driver'
        END AS card_category,
        cr.recommended_bet_type,
        COUNT(*) AS settled_cards,
        SUM(CASE WHEN cr.result = 'win' THEN 1 ELSE 0 END) AS wins,
        SUM(CASE WHEN cr.result = 'loss' THEN 1 ELSE 0 END) AS losses,
        SUM(CASE WHEN cr.result = 'push' THEN 1 ELSE 0 END) AS pushes,
        SUM(COALESCE(cr.pnl_units, 0)) AS total_pnl_units
      FROM card_results cr
      WHERE cr.id IN (?, ?, ?)
      GROUP BY cr.sport, card_category, cr.recommended_bet_type
      ORDER BY cr.sport ASC, card_category ASC, cr.recommended_bet_type ASC
    `,
    endpoint: '/api/results',
    parameterized: true,
    parameters: ['id1', 'id2', 'id3'],
  },
  {
    name: 'results: Ledger with joins',
    sql: `
      SELECT
        cr.id,
        cr.game_id,
        cr.sport,
        cr.card_type,
        cr.recommended_bet_type,
        cr.market_key,
        cr.market_type,
        cr.selection,
        cr.line,
        cr.locked_price,
        cr.result,
        cr.pnl_units,
        cr.settled_at,
        cp.id AS payload_id,
        cp.created_at,
        cp.payload_data,
        g.home_team AS game_home_team,
        g.away_team AS game_away_team
      FROM card_results cr
      LEFT JOIN card_payloads cp ON cr.card_id = cp.id
      LEFT JOIN games g ON cr.game_id = g.game_id
      WHERE cr.id IN (?, ?, ?)
      ORDER BY cr.settled_at DESC
    `,
    endpoint: '/api/results',
    parameterized: true,
    parameters: ['id1', 'id2', 'id3'],
  },
];

interface AuditEntry {
  name: string;
  endpoint: string;
  parameterized: boolean;
  safe: boolean;
  riskLevel: string;
  issues: string[];
}

function runAudit(): void {
  console.log('🔐 Database Security Audit Report\n');
  console.log('='.repeat(80));

  const results: AuditEntry[] = [];

  for (const query of QUERIES_TO_AUDIT) {
    const result = auditSQLQuery(query.sql);
    results.push({
      name: query.name,
      endpoint: query.endpoint,
      parameterized: query.parameterized,
      safe: result.safe,
      riskLevel: result.riskLevel,
      issues: result.issues,
    });
  }

  // Group by endpoint
  const byEndpoint = new Map<string, AuditEntry[]>();
  for (const entry of results) {
    if (!byEndpoint.has(entry.endpoint)) {
      byEndpoint.set(entry.endpoint, []);
    }
    byEndpoint.get(entry.endpoint)!.push(entry);
  }

  // Display results by endpoint
  for (const [endpoint, entries] of byEndpoint) {
    console.log(`\n📍 Endpoint: ${endpoint}`);
    console.log('-'.repeat(80));

    for (const entry of entries) {
      const statusIcon = entry.safe ? '✅' : '⚠️ ';
      const riskBadge =
        entry.riskLevel === 'SAFE' ? '✅ SAFE' : `🔴 ${entry.riskLevel}`;
      const paramBadge = entry.parameterized ? '[PARAMETERIZED]' : '[STATIC]';

      console.log(`\n${statusIcon} ${entry.name}`);
      console.log(`   Risk Level: ${riskBadge}  ${paramBadge}`);

      if (!entry.safe) {
        console.log(`   Issues:`);
        for (const issue of entry.issues) {
          console.log(`     • ${issue}`);
        }
      }
    }
  }

  // Generate summary report
  const auditQueryObjects = QUERIES_TO_AUDIT.map((q) => ({
    name: q.name,
    sql: q.sql,
  }));
  const report = generateAuditReport(auditQueryObjects);
  console.log('\n' + '='.repeat(80));
  console.log('\n📊 Audit Summary');
  console.log('-'.repeat(80));
  console.log(`Total Queries Audited: ${results.length}`);
  console.log(`Safe Queries: ${results.filter((r) => r.safe).length}`);
  console.log(`Risk Summary: ${report}`);
  console.log('\n' + '='.repeat(80));

  // Overall verdict
  const allSafe = results.every((r) => r.safe);
  if (allSafe) {
    console.log(
      '\n✅ AUDIT PASSED: All queries are properly parameterized and safe from SQL injection.\n',
    );
  } else {
    console.log(
      '\n⚠️  AUDIT WARNINGS: Some queries have potential issues. Review above.\n',
    );
  }
}

runAudit();
