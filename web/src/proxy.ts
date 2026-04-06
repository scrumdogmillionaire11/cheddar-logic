/**
 * Next.js Proxy - Security Headers + Dev-Only Route Guard
 *
 * This proxy applies security headers to all HTTP responses and enforces
 * a production firewall for dev-only routes.
 * Runs on every request before route handlers.
 *
 * Security headers included:
 * - Content-Security-Policy (CSP) - Prevents XSS
 * - Strict-Transport-Security (HSTS) - Forces HTTPS
 * - X-Frame-Options - Prevents clickjacking
 * - X-Content-Type-Options - Prevents MIME sniffing
 * - Referrer-Policy - Controls referrer leakage
 * - X-XSS-Protection - Legacy XSS protection
 * - Permissions-Policy - Restricts browser features
 *
 * Dev-only route enforcement:
 * /admin and /api/admin/* are development diagnostic tools that must NEVER
 * be reachable in production. This proxy is the single authoritative gate —
 * it runs before any page or API route handler so even if an individual
 * file's NODE_ENV check is accidentally removed, this block holds.
 *
 * Do NOT add exceptions. Do NOT add a flag to re-enable in production.
 */

import { NextRequest, NextResponse } from 'next/server';
import { createSecurityHeaders } from './lib/api-security/security-headers';

// Paths that are dev-only. All sub-paths are blocked via prefix matching.
const DEV_ONLY_PREFIXES = ['/admin', '/api/admin'];

export function proxy(request: NextRequest): NextResponse {
  const { pathname } = request.nextUrl;

  const isDevOnlyRoute = DEV_ONLY_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(prefix + '/'),
  );

  if (isDevOnlyRoute && process.env.NODE_ENV !== 'development') {
    // Return a plain 404 — do not reveal that the route exists or why it's
    // blocked. This prevents enumeration of internal tooling paths.
    return new NextResponse(null, { status: 404 });
  }

  const response = NextResponse.next();

  const securityHeaders = createSecurityHeaders();
  Object.entries(securityHeaders).forEach(([key, value]: [string, string]) => {
    response.headers.set(key, value);
  });

  return response;
}

export const config = {
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico|public).*)',
  ],
};
