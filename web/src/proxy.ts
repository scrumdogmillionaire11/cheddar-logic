/**
 * Next.js Proxy - Security Headers + Dev-Only Route Guard (reference copy)
 *
 * NOTE: The active middleware logic now lives directly in middleware.ts.
 * This file is kept as a named utility for any non-middleware callers
 * (e.g. tests, shared logic). It is NOT imported by middleware.ts.
 *
 * middleware.ts inlines the security headers and route-guard logic to avoid
 * Edge-runtime/Turbopack module-resolution issues with re-exports.
 */
