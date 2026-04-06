/**
 * Next.js Proxy (Next.js 16+ convention — replaces middleware.ts)
 *
 * Applies security headers to all HTTP responses and enforces a production
 * firewall for dev-only routes (/admin, /api/admin/*).
 *
 * /admin and /api/admin/* are Model Health diagnostic tools that must NEVER
 * be reachable in production. This file is the single authoritative gate —
 * it runs before any page or API route handler.
 *
 * ⚠️  CRITICAL: middleware.ts must NEVER exist alongside this file.
 * Next.js 16 throws an unhandled rejection at startup when both are present,
 * which silently kills all route handlers — /api/games, /api/cards, etc.
 * Only pre-injected scripts (e.g. Cloudflare RUM beacons) survive the crash.
 * CI and the Pi deploy script both enforce this invariant.
 *
 * Do NOT add exceptions. Do NOT add flags to re-enable in production.
 */

import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

// Paths that are dev-only. All sub-paths are blocked via prefix matching.
const DEV_ONLY_PREFIXES = ['/admin', '/api/admin'];

// Security headers inlined to avoid any Edge-runtime module resolution issues.
const cspConnectSrc =
  process.env.NODE_ENV === 'development'
    ? "connect-src 'self' https://cloudflareinsights.com http://localhost:8000 http://localhost:8001"
    : "connect-src 'self' https://cloudflareinsights.com";

const cspScriptSrc =
  process.env.NODE_ENV === 'development'
    ? "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://static.cloudflareinsights.com"
    : "script-src 'self' 'unsafe-inline' https://static.cloudflareinsights.com";

const SECURITY_HEADERS: Record<string, string> = {
  'Content-Security-Policy': `default-src 'self'; ${cspScriptSrc}; style-src 'self' 'unsafe-inline'; img-src 'self' https: data:; font-src 'self' data:; ${cspConnectSrc}; frame-ancestors 'none'; form-action 'self'; base-uri 'self'`,
  'Strict-Transport-Security': 'max-age=31536000; includeSubDomains; preload',
  'X-Frame-Options': 'DENY',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-XSS-Protection': '1; mode=block',
  'Permissions-Policy': 'geolocation=(), microphone=(), camera=(), payment=(), usb=()',
  'X-Permitted-Cross-Domain-Policies': 'none',
};

export function proxy(request: NextRequest): NextResponse {
  const { pathname } = request.nextUrl;

  const isDevOnlyRoute = DEV_ONLY_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(prefix + '/'),
  );

  if (isDevOnlyRoute && process.env.NODE_ENV !== 'development') {
    // Plain 404 — do not reveal the route exists or why it's blocked.
    return new NextResponse(null, { status: 404 });
  }

  const response = NextResponse.next();
  for (const [key, value] of Object.entries(SECURITY_HEADERS)) {
    response.headers.set(key, value);
  }
  return response;
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|public).*)'],
};
