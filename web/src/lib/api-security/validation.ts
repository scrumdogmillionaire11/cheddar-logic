/**
 * Input validation and sanitization utilities for API endpoints
 */

// List of allowed keys for query parameters per endpoint.
// Keep this in sync with all performSecurityChecks(...) route paths.
const ALLOWED_QUERY_PARAMS: Record<string, Set<string>> = {
  '/api/games': new Set(['limit', 'offset', 'sport', 'filter', 'lifecycle']),
  '/api/cards': new Set([
    'gameId',
    'sport',
    'card_type',
    'game_id',
    'include_expired',
    'dedupe',
    'limit',
    'offset',
    'lifecycle',
    'date',
    'surface',
  ]),
  '/api/cards/[gameId]': new Set([
    'cardType',
    'card_type',
    'dedupe',
    'limit',
    'offset',
    'lifecycle',
  ]),
  '/api/props': new Set(['gameId', 'limit', 'offset']),
  '/api/props/player-shots': new Set(['limit', 'date']),
  '/api/props/player-blk': new Set(['limit', 'date']),
  '/api/props/pitcher-ks': new Set(['limit', 'date']),
  '/api/auth/token': new Set(['role', 'subscription', 'email', 'userId']),
  '/api/auth/logout': new Set([]),
  '/api/performance': new Set(['market', 'days']),
  '/api/model-outputs': new Set(['sport']),
  '/api/results': new Set([
    'limit',
    'offset',
    'sport',
    'card_category',
    'min_confidence',
    'market',
    'include_orphaned',
    'dedupe',
    '_diag',
  ]),
  '/api/results/projection-settled': new Set([]),
  '/api/team-metrics': new Set([
    'team',
    'sport',
    'home_team',
    'away_team',
    'include_games',
    'limit',
  ]),
  '/api/admin/model-health': new Set([]),
  '/api/admin/pipeline-health': new Set([]),
  '/api/potd': new Set([]),
};

export function getValidationRegistryPaths(): string[] {
  return Object.keys(ALLOWED_QUERY_PARAMS).sort();
}

export function isValidationPathRegistered(path: string): boolean {
  return Object.prototype.hasOwnProperty.call(ALLOWED_QUERY_PARAMS, path);
}

export interface ValidationResult {
  valid: boolean;
  errors: string[];
  sanitizedParams: Record<string, string | number>;
}

/**
 * Validate query parameters against whitelist
 * @param path - API route path
 * @param params - Query parameters to validate
 * @returns Validation result
 */
export function validateQueryParams(
  path: string,
  params: Record<string, string | string[]>,
): ValidationResult {
  const errors: string[] = [];
  const sanitized: Record<string, string | number> = {};

  const allowed = ALLOWED_QUERY_PARAMS[path];

  if (!allowed) {
    return {
      valid: false,
      errors: ['Unknown API endpoint'],
      sanitizedParams: {},
    };
  }

  // Check for unknown parameters
  for (const key of Object.keys(params)) {
    if (!allowed.has(key)) {
      errors.push(`Unknown parameter: ${key}`);
    }
  }

  if (errors.length > 0) {
    return { valid: false, errors, sanitizedParams: {} };
  }

  // Validate and sanitize known parameters
  for (const key of Array.from(allowed)) {
    const value = params[key];

    if (!value) continue;

    const stringValue = Array.isArray(value) ? value[0] : value;

    // Integer numeric parameters: limit, offset
    if (key === 'limit' || key === 'offset') {
      const num = parseInt(stringValue, 10);
      if (isNaN(num)) {
        errors.push(`${key} must be a number`);
      } else if (num < 0) {
        errors.push(`${key} must be non-negative`);
      } else if (key === 'limit' && num > 1000) {
        errors.push('limit must be <= 1000');
      } else {
        sanitized[key] = num;
      }
    }

    // Rolling window parameter for /api/performance
    if (key === 'days') {
      const num = parseInt(stringValue, 10);
      if (isNaN(num)) {
        errors.push(`${key} must be a number`);
      } else if (num < 1 || num > 365) {
        errors.push(`${key} must be between 1 and 365`);
      } else {
        sanitized[key] = num;
      }
    }

    // Float percentage parameters
    if (key === 'min_confidence') {
      const num = Number.parseFloat(stringValue);
      if (Number.isNaN(num)) {
        errors.push(`${key} must be a number`);
      } else if (num < 0 || num > 100) {
        errors.push(`${key} must be between 0 and 100`);
      } else {
        sanitized[key] = num;
      }
    }

    // Boolean-ish parameters
    if (key === 'include_orphaned') {
      const normalized = stringValue.trim().toLowerCase();
      const valid = ['1', '0', 'true', 'false', 'yes', 'no', 'on', 'off'];
      if (!valid.includes(normalized)) {
        errors.push(`${key} must be boolean-like (0/1/true/false)`);
      } else {
        sanitized[key] = normalized;
      }
    }

    // Dedupe mode parameter
    if (key === 'dedupe') {
      const normalized = stringValue.trim().toLowerCase();
      const valid = ['1', '0', 'true', 'false', 'yes', 'no', 'on', 'off', 'none', 'latest_per_game_type'];
      if (!valid.includes(normalized)) {
        errors.push(`${key} must be boolean-like (0/1/true/false) or 'none'/'latest_per_game_type'`);
      } else {
        sanitized[key] = normalized;
      }
    }

    // String parameters
    if (
      key === 'gameId' ||
      key === 'sport' ||
      key === 'filter' ||
      key === 'team' ||
      key === 'card_category' ||
      key === 'market'
    ) {
      if (stringValue.length > 100) {
        errors.push(`${key} must be <= 100 characters`);
      } else if (!/^[a-zA-Z0-9\-_]+$/.test(stringValue)) {
        errors.push(`${key} contains invalid characters`);
      } else {
        sanitized[key] = stringValue;
      }
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    sanitizedParams: sanitized,
  };
}

/**
 * Validate request body size
 * @param request - Next.js Request object
 * @param maxBytes - Maximum allowed size in bytes (default: 1MB)
 * @returns Whether request is within size limit
 */
export function validateRequestSize(
  request: Request,
  maxBytes = 1024 * 1024,
): boolean {
  const contentLength = request.headers.get('content-length');
  if (!contentLength) return true; // Allow if not specified (GET requests)

  const size = parseInt(contentLength, 10);
  return size <= maxBytes;
}

/**
 * Sanitize string input
 * Removes potentially harmful characters and patterns
 */
export function sanitizeString(input: string): string {
  return input
    .trim()
    .replace(/[<>\"'%;()&+]/g, '') // Remove HTML/SQL special chars
    .substring(0, 100); // Limit length
}

/**
 * Create error response
 */
export function createValidationErrorResponse(errors: string[]) {
  return {
    success: false,
    error: 'Validation failed',
    details: errors,
  };
}
