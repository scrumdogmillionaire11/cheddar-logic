/**
 * Security feature flags and defaults.
 */

export const SECURITY_CONFIG = {
  rateLimit: true,
  inputValidation: true,
  securityHeaders: true,
  auditLogging: process.env.ENABLE_AUDIT_LOGGING !== 'false',
  rbacEnforcement: process.env.ENABLE_RBAC !== 'false',
};
