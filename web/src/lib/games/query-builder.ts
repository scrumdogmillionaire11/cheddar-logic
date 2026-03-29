/**
 * buildOptionalOddsSelect and query composition helpers extracted from route.ts (WI-0621)
 */

// NOTE: The DB type below uses `any` to avoid coupling this module to the
// @cheddar-logic/data package import (which causes Next.js bundle issues when
// imported outside of API route files). Callers pass the result of
// getDatabaseReadOnly() which satisfies the duck-typed interface.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type DbInstance = any;

export function toSqlUtc(date: Date): string {
  return date.toISOString().substring(0, 19).replace('T', ' ');
}

export function getTableColumnNames(
  db: DbInstance,
  tableName: string,
): Set<string> {
  try {
    const rows = db
      .prepare(`PRAGMA table_info(${tableName})`)
      .all() as Array<{ name?: string }>;
    return new Set(
      rows
        .map((row) => (typeof row.name === 'string' ? row.name : ''))
        .filter(Boolean),
    );
  } catch {
    return new Set();
  }
}

export function buildOptionalOddsSelect(
  availableColumns: Set<string>,
  columnName: string,
): string {
  return availableColumns.has(columnName)
    ? `o.${columnName}`
    : `NULL AS ${columnName}`;
}
