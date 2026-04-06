/**
 * Edge middleware — primary gate for dev-only routes.
 *
 * /admin and /api/admin/* are NEVER reachable in production.
 * This runs before any route handler or layout, so even a misconfigured
 * environment variable cannot expose these routes.
 *
 * Secondary guards (layout notFound(), API route 404 returns) remain as
 * belt-and-suspenders but this is the authoritative block.
 */

import { NextRequest, NextResponse } from 'next/server';

const DEV_ONLY_PREFIXES = ['/admin', '/api/admin'];

export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  const isDevOnlyPath = DEV_ONLY_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(prefix + '/'),
  );

  if (isDevOnlyPath && process.env.NODE_ENV !== 'development') {
    return new NextResponse(null, { status: 404 });
  }

  return NextResponse.next();
}

export const config = {
  matcher: ['/admin', '/admin/:path*', '/api/admin', '/api/admin/:path*'],
};
