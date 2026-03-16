/**
 * Next.js Proxy - Security Headers
 *
 * This proxy applies security headers to all HTTP responses.
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
 */

import { NextResponse } from 'next/server';
import { createSecurityHeaders } from './lib/api-security/security-headers';

export function proxy() {
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
