/**
 * Security feature flags and defaults.
 */

const ENABLE_RBAC = process.env.ENABLE_RBAC;

if (process.env.NODE_ENV === 'production' && ENABLE_RBAC === 'false') {
  throw new Error(
    'ENABLE_RBAC=false is not allowed in production; auth enforcement must remain fail-closed.',
  );
}

export const SECURITY_CONFIG = {
  rateLimit: true,
  inputValidation: true,
  securityHeaders: true,
  auditLogging: process.env.ENABLE_AUDIT_LOGGING !== 'false',
  rbacEnforcement: ENABLE_RBAC !== 'false',
};

// Explicit allowlist for intentionally public routes.
export const PUBLIC_ROUTES = new Set<string>(['/wedge', '/fpl']);

export function isPublicRoute(pathname: string): boolean {
  return PUBLIC_ROUTES.has(pathname);
}
