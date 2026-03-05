/**
 * SQL Injection Prevention & Detection Utilities
 * Analyzes and validates SQL queries for security risks
 */

export interface SQLAuditResult {
  safe: boolean;
  riskLevel: 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW' | 'SAFE';
  issues: string[];
  warnings: string[];
  recommendations: string[];
}

/**
 * Patterns that indicate potential SQL injection risks
 */
const DANGEROUS_PATTERNS = [
  {
    pattern: /\$\{.*?\}/,
    risk: 'CRITICAL',
    message:
      'Template literal interpolation detected - use parameterized queries instead',
  },
  {
    pattern: /\+\s*['"`]/,
    risk: 'HIGH',
    message:
      'String concatenation with quotes detected - may indicate SQL injection risk',
  },
  {
    pattern: /WHERE\s+\w+\s*=\s*['"`][^'"` ]/,
    risk: 'HIGH',
    message: 'Hard-coded values in WHERE clause detected',
  },
  {
    pattern: /LIKE\s*['"`]/,
    risk: 'MEDIUM',
    message:
      'LIKE with potential unescaped wildcards - ensure values are sanitized',
  },
  {
    pattern: /UNION\s+SELECT|UNION\s+ALL/i,
    risk: 'MEDIUM',
    message:
      'UNION query detected - ensure all SELECT statements are authorized',
  },
  {
    pattern: /exec|execute|pragma|pragma\s+writable_schema/i,
    risk: 'CRITICAL',
    message: 'Potentially dangerous SQL command detected',
  },
];

const SAFE_PATTERNS = [
  {
    pattern: /db\.prepare\([^)]+\)\.(?:all|get|run)\s*\(\s*\.\.\./,
    message: 'Using spread operator for parameterized queries - good practice',
  },
  {
    pattern: /\?/,
    message:
      'Question mark placeholders detected - parameterized query pattern',
  },
  {
    pattern: /stmt\.(?:all|get|run|bind)/,
    message: 'Using prepared statement methods - good practice',
  },
];

/**
 * Audit SQL query for injection risks
 * @param query - SQL query string
 * @returns Audit result with issues and recommendations
 */
export function auditSQLQuery(query: string): SQLAuditResult {
  const result: SQLAuditResult = {
    safe: true,
    riskLevel: 'SAFE',
    issues: [],
    warnings: [],
    recommendations: [],
  };

  // Check for dangerous patterns
  for (const { pattern, risk, message } of DANGEROUS_PATTERNS) {
    if (pattern.test(query)) {
      result.issues.push(message);
      result.safe = false;
      if (risk === 'CRITICAL' || risk === 'HIGH') {
        result.riskLevel = risk;
      }
    }
  }

  // Check for safe patterns
  let hasSafePatterns = 0;
  for (const { pattern } of SAFE_PATTERNS) {
    if (pattern.test(query)) {
      hasSafePatterns++;
    }
  }

  // If no placeholders and query has parameters, flag it
  if (!SAFE_PATTERNS[1].pattern.test(query) && query.includes('WHERE')) {
    result.warnings.push(
      'No parameter placeholders detected - ensure query is parameterized',
    );
  }

  // Recommendations based on risk level
  if (result.riskLevel === 'CRITICAL') {
    result.recommendations.push(
      '⛔ STOP - Do not use this query in production without major refactoring',
    );
    result.recommendations.push(
      'Use parameterized queries with ? placeholders instead',
    );
    result.recommendations.push(
      'Never use template literals or string concatenation for query building',
    );
  } else if (result.riskLevel === 'HIGH') {
    result.recommendations.push(
      '⚠️  Use parameterized queries (?) for all variable values',
    );
    result.recommendations.push(
      'Validate and sanitize all user inputs before use',
    );
    result.recommendations.push(
      'Use prepared statements instead of string concatenation',
    );
  } else if (result.riskLevel === 'MEDIUM') {
    result.recommendations.push('Review query for proper parameterization');
    result.recommendations.push(
      'Ensure wildcards (%) are escaped if from user input',
    );
  } else if (hasSafePatterns > 0) {
    result.recommendations.push(
      '✅ Query appears to use safe parameterized pattern',
    );
  }

  return result;
}

/**
 * Check if query uses parameterized approach
 */
export function isParameterized(query: string): boolean {
  // Check for placeholders (SQLite uses ?)
  return /\?/.test(query);
}

/**
 * Extract parameter positions from query
 */
export function getParameterCount(query: string): number {
  const matches = query.match(/\?/g);
  return matches ? matches.length : 0;
}

/**
 * Validate that parameter count matches array length
 */
export function validateParameterCount(
  query: string,
  params: Array<string | number | null>,
): { valid: boolean; message?: string } {
  const expectedCount = getParameterCount(query);
  const actualCount = params.length;

  if (expectedCount !== actualCount) {
    return {
      valid: false,
      message: `Parameter count mismatch: expected ${expectedCount}, got ${actualCount}`,
    };
  }

  return { valid: true };
}

/**
 * Check for SQL keywords that may indicate injection attempts
 */
export function detectInjectionAttempts(input: string): {
  suspicious: boolean;
  keywords: string[];
} {
  const injectionKeywords = [
    'UNION',
    'SELECT',
    'INSERT',
    'UPDATE',
    'DELETE',
    'DROP',
    'CREATE',
    'ALTER',
    'EXEC',
    'EXECUTE',
    '--',
    '/*',
    '*/',
    ';',
  ];

  const found = injectionKeywords.filter((kw) =>
    new RegExp(`\\b${kw}\\b`, 'i').test(input),
  );

  return {
    suspicious: found.length > 0,
    keywords: found,
  };
}

/**
 * Sanitize input string for safe LIKE queries
 * Escapes SQLite wildcard characters
 */
export function escapeLikeWildcards(input: string): string {
  return input
    .replace(/[\%_]/g, '\\$&') // Escape % and _ for LIKE
    .replace(/[']/g, "''"); // Escape single quotes for SQLite
}

/**
 * Validate that a string is a valid identifier (table/column name)
 * Only allows alphanumeric, underscore, and prevents SQL injection via identifier
 */
export function isValidIdentifier(name: string): boolean {
  return /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name);
}

/**
 * Generate report showing all SQL queries and their safety
 */
export function generateAuditReport(
  queries: Array<{ name: string; sql: string }>,
) {
  const report = queries.map((q) => {
    const audit = auditSQLQuery(q.sql);
    return {
      name: q.name,
      parameterized: isParameterized(q.sql),
      parameterCount: getParameterCount(q.sql),
      audit,
    };
  });

  const critical = report.filter(
    (r) => r.audit.riskLevel === 'CRITICAL',
  ).length;
  const high = report.filter((r) => r.audit.riskLevel === 'HIGH').length;
  const medium = report.filter((r) => r.audit.riskLevel === 'MEDIUM').length;
  const safe = report.filter((r) => r.audit.riskLevel === 'SAFE').length;

  return {
    summary: {
      total: report.length,
      critical,
      high,
      medium,
      safe,
    },
    queries: report,
  };
}
