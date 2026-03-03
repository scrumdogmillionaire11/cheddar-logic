/**
 * Audit Event Types
 *
 * Constants for all security audit events logged in the system
 */

export enum AuditEventType {
  // Authentication events
  AUTH_TOKEN_GENERATED = 'AUTH_TOKEN_GENERATED',
  AUTH_TOKEN_VALID = 'AUTH_TOKEN_VALID',
  AUTH_TOKEN_INVALID = 'AUTH_TOKEN_INVALID',
  AUTH_TOKEN_EXPIRED = 'AUTH_TOKEN_EXPIRED',
  AUTH_MISSING = 'AUTH_MISSING',
  AUTH_ROLE_DENIED = 'AUTH_ROLE_DENIED',

  // Rate limiting events
  RATE_LIMIT_EXCEEDED = 'RATE_LIMIT_EXCEEDED',
  RATE_LIMIT_WARN = 'RATE_LIMIT_WARN', // 80%+ of limit

  // Input validation events
  VALIDATION_ERROR = 'VALIDATION_ERROR',
  INVALID_QUERY_PARAM = 'INVALID_QUERY_PARAM',
  REQUEST_SIZE_EXCEEDED = 'REQUEST_SIZE_EXCEEDED',
  MALFORMED_INPUT = 'MALFORMED_INPUT',

  // SQL injection detection
  SQL_INJECTION_ATTEMPT = 'SQL_INJECTION_ATTEMPT',
  SUSPICIOUS_SQL_PATTERN = 'SUSPICIOUS_SQL_PATTERN',

  // General events
  API_SUCCESS = 'API_SUCCESS',
  API_ERROR = 'API_ERROR',
  SUSPICIOUS_REQUEST = 'SUSPICIOUS_REQUEST',
}

/**
 * Audit Event Severity Levels
 */
export enum AuditEventSeverity {
  INFO = 'INFO',
  WARN = 'WARN',
  ERROR = 'ERROR',
  CRITICAL = 'CRITICAL',
}

/**
 * Severity mapping for event types
 */
export const EVENT_SEVERITY_MAP: Record<AuditEventType, AuditEventSeverity> = {
  [AuditEventType.AUTH_TOKEN_GENERATED]: AuditEventSeverity.INFO,
  [AuditEventType.AUTH_TOKEN_VALID]: AuditEventSeverity.INFO,
  [AuditEventType.AUTH_TOKEN_INVALID]: AuditEventSeverity.WARN,
  [AuditEventType.AUTH_TOKEN_EXPIRED]: AuditEventSeverity.WARN,
  [AuditEventType.AUTH_MISSING]: AuditEventSeverity.WARN,
  [AuditEventType.AUTH_ROLE_DENIED]: AuditEventSeverity.WARN,

  [AuditEventType.RATE_LIMIT_EXCEEDED]: AuditEventSeverity.ERROR,
  [AuditEventType.RATE_LIMIT_WARN]: AuditEventSeverity.WARN,

  [AuditEventType.VALIDATION_ERROR]: AuditEventSeverity.WARN,
  [AuditEventType.INVALID_QUERY_PARAM]: AuditEventSeverity.WARN,
  [AuditEventType.REQUEST_SIZE_EXCEEDED]: AuditEventSeverity.WARN,
  [AuditEventType.MALFORMED_INPUT]: AuditEventSeverity.WARN,

  [AuditEventType.SQL_INJECTION_ATTEMPT]: AuditEventSeverity.CRITICAL,
  [AuditEventType.SUSPICIOUS_SQL_PATTERN]: AuditEventSeverity.ERROR,

  [AuditEventType.API_SUCCESS]: AuditEventSeverity.INFO,
  [AuditEventType.API_ERROR]: AuditEventSeverity.ERROR,
  [AuditEventType.SUSPICIOUS_REQUEST]: AuditEventSeverity.WARN,
};

/**
 * Description map for event types
 */
export const EVENT_DESCRIPTION_MAP: Record<AuditEventType, string> = {
  [AuditEventType.AUTH_TOKEN_GENERATED]: 'JWT token generated for dev/testing',
  [AuditEventType.AUTH_TOKEN_VALID]: 'Token verified successfully',
  [AuditEventType.AUTH_TOKEN_INVALID]: 'Token signature or claim validation failed',
  [AuditEventType.AUTH_TOKEN_EXPIRED]: 'Token has expired',
  [AuditEventType.AUTH_MISSING]: 'Authorization header missing or malformed',
  [AuditEventType.AUTH_ROLE_DENIED]: 'User lacks required role for resource',

  [AuditEventType.RATE_LIMIT_EXCEEDED]: 'Request rate limit exceeded for IP address',
  [AuditEventType.RATE_LIMIT_WARN]: 'Client approaching rate limit threshold',

  [AuditEventType.VALIDATION_ERROR]: 'Request validation failed',
  [AuditEventType.INVALID_QUERY_PARAM]: 'Query parameter not in whitelist',
  [AuditEventType.REQUEST_SIZE_EXCEEDED]: 'Request payload exceeds size limit',
  [AuditEventType.MALFORMED_INPUT]: 'Request body or parameters malformed',

  [AuditEventType.SQL_INJECTION_ATTEMPT]: 'Potential SQL injection detected in query',
  [AuditEventType.SUSPICIOUS_SQL_PATTERN]: 'Suspicious SQL pattern in parameterized query',

  [AuditEventType.API_SUCCESS]: 'Request processed successfully',
  [AuditEventType.API_ERROR]: 'Request failed with error',
  [AuditEventType.SUSPICIOUS_REQUEST]: 'Request exhibits suspicious characteristics',
};
