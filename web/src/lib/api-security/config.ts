/**
 * Security feature flags and defaults.
 */

const ENABLE_RBAC = process.env.ENABLE_RBAC;

function readPositiveIntegerEnv(name: string, defaultValue: number): number {
  const rawValue = process.env[name];
  if (!rawValue) {
    return defaultValue;
  }

  const parsed = Number.parseInt(rawValue, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : defaultValue;
}

export const RATE_LIMIT_CONFIG = {
  maxRequests: readPositiveIntegerEnv('RATE_LIMIT_MAX_REQUESTS', 360),
  windowMs: readPositiveIntegerEnv('RATE_LIMIT_WINDOW_MS', 60 * 60 * 1000),
  stateFilePath: process.env.RATE_LIMIT_STATE_FILE,
  lockWaitMs: readPositiveIntegerEnv('RATE_LIMIT_LOCK_WAIT_MS', 250),
  lockStaleMs: readPositiveIntegerEnv('RATE_LIMIT_LOCK_STALE_MS', 5000),
};

/**
 * Auth wall rollout switch.
 *
 * Defaults to disabled in every environment until explicitly enabled.
 */
export function isApiAuthEnforced(): boolean {
  return process.env.ENABLE_API_AUTH === 'true';
}

export const SECURITY_CONFIG = {
  rateLimit: true,
  rateLimiter: RATE_LIMIT_CONFIG,
  inputValidation: true,
  securityHeaders: true,
  auditLogging: process.env.ENABLE_AUDIT_LOGGING !== 'false',
  rbacEnforcement: ENABLE_RBAC !== 'false',
  apiAuthEnforcement: isApiAuthEnforced(),
};

// Explicit allowlist for intentionally public routes.
export const PUBLIC_ROUTES = new Set<string>(['/wedge', '/fpl']);

export function isPublicRoute(pathname: string): boolean {
  return PUBLIC_ROUTES.has(pathname);
}
