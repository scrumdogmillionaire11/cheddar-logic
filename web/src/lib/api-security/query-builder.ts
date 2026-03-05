/**
 * Safe Query Builder for SQL Injection Prevention
 * Provides helper functions for building parameterized SQL queries
 */

/**
 * Build IN clause safely with parameters
 * Example:
 *   const { clause, params } = buildInClause('game_id', gameIds);
 *   const rows = db.prepare(`SELECT * FROM games WHERE ${clause}`).all(...params);
 */
export function buildInClause(
  column: string,
  values: Array<string | number>,
): { clause: string; params: Array<string | number> } {
  if (!values.length) {
    return {
      clause: `${column} IN (NULL)`,
      params: [],
    };
  }

  const placeholders = values.map(() => '?').join(',');
  return {
    clause: `${column} IN (${placeholders})`,
    params: values,
  };
}

/**
 * Build WHERE clause with AND conditions
 * Example:
 *   const where = buildWhereClause({
 *     sport: userInput
 *     status: 'active'
 *   });
 *   const sql = `SELECT * FROM cards WHERE ${where.sql}`;
 *   const rows = db.prepare(sql).all(...where.params);
 */
export function buildWhereClause(
  conditions: Record<string, string | number | boolean | null>,
): { sql: string; params: Array<string | number> } {
  const parts: string[] = [];
  const params: Array<string | number> = [];

  for (const [column, value] of Object.entries(conditions)) {
    if (value === null || value === undefined) {
      parts.push(`${column} IS NULL`);
    } else {
      parts.push(`${column} = ?`);
      params.push(value as string | number);
    }
  }

  const sql = parts.length > 0 ? `${parts.join(' AND ')}` : '1=1';

  return { sql, params };
}

/**
 * Safe LIKE query builder
 * Automatically escapes wildcards
 * Example:
 *   const { clause, params } = buildLikeClause('team_name', userSearch);
 *   db.prepare(`SELECT * FROM teams WHERE ${clause}`).all(...params);
 */
export function buildLikeClause(
  column: string,
  pattern: string,
  escapeWildcards = true,
): { clause: string; params: [string] } {
  let safePattern = pattern;

  if (escapeWildcards) {
    safePattern = pattern
      .replace(/\\/g, '\\\\') // Escape backslashes first
      .replace(/%/g, '\\%') // Escape %
      .replace(/_/g, '\\_'); // Escape _
  }

  return {
    clause: `${column} LIKE ? ESCAPE '\\'`,
    params: [safePattern],
  };
}

/**
 * Build ORDER BY clause safely
 * Only allows whitelisted columns
 */
export function buildOrderByClause(
  column: string,
  direction: 'ASC' | 'DESC',
  allowedColumns: Set<string>,
): { sql: string } {
  if (!allowedColumns.has(column)) {
    throw new Error(`Invalid column name for ORDER BY: ${column}`);
  }

  // Direction must be exactly ASC or DESC (already validated by type)
  return {
    sql: `ORDER BY ${column} ${direction}`,
  };
}

/**
 * Build LIMIT/OFFSET clause safely
 * Validates numeric values
 */
export function buildLimitClause(
  limit: number,
  offset = 0,
): { sql: string; params: [number, number] } {
  const safeLimit = Math.max(0, Math.min(limit, 10000)); // Cap at 10k
  const safeOffset = Math.max(0, offset);

  return {
    sql: `LIMIT ? OFFSET ?`,
    params: [safeLimit, safeOffset],
  };
}

/**
 * Example safe query composition
 * This demonstrates how to build complex queries safely
 */
export function buildSafeGameQuery(filters: {
  sport?: string;
  status?: string;
  limit?: number;
  offset?: number;
}): { sql: string; params: Array<string | number> } {
  const conditions: Record<string, string | number | boolean | null> = {};
  if (filters.sport) conditions['sport'] = filters.sport;
  if (filters.status) conditions['status'] = filters.status;

  const where = buildWhereClause(conditions);
  const limit = buildLimitClause(filters.limit || 20, filters.offset || 0);

  const sql = `
    SELECT * FROM games
    WHERE ${where.sql}
    ${limit.sql}
  `;

  const params = [...where.params, ...limit.params];

  return { sql, params };
}
