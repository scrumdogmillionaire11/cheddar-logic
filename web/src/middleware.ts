/**
 * Next.js Middleware - Security Headers
 *
 * This middleware applies security headers to all HTTP responses.
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

export function middleware() {
  // Create response with security headers
  const response = NextResponse.next();

  // Add all security headers
  const securityHeaders = createSecurityHeaders();
  Object.entries(securityHeaders).forEach(([key, value]: [string, string]) => {
    response.headers.set(key, value);
  });

  return response;
}

// Configure which routes should have middleware applied
// We apply it to all routes except static assets and Next.js internals
export const config = {
  matcher: [
    /*
     * Match all request paths except for the ones starting with:
     * - _next/static (static files)
     * - _next/image (image optimization files)
     * - favicon.ico (favicon file)
     * - public folder files
     */
    '/((?!_next/static|_next/image|favicon.ico|public).*)',
  ],
};
