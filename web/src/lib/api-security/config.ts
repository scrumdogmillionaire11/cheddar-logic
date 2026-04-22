/**
 * Security feature flags and defaults.
 */

const ENABLE_RBAC = process.env.ENABLE_RBAC;

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
