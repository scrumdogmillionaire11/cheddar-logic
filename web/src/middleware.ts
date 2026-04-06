/**
 * Next.js Edge Middleware — production firewall for dev-only routes.
 *
 * WHY THIS EXISTS
 * ---------------
 * /admin and /api/admin/* are development diagnostic tools (Model Health
 * dashboard, pipeline-health API, audit log, odds-ingest diagnostics).
 * They must NEVER be reachable in production, regardless of per-file guards.
 *
 * This middleware is the single authoritative gate. It runs at the Edge
 * before any page or API route handler, so even if an individual file's
 * NODE_ENV check is accidentally removed or bypassed, this block holds.
 *
 * ENFORCEMENT CONTRACT
 * --------------------
 *  - NODE_ENV !== 'development'  →  all /admin and /api/admin/* return 404
 *  - NODE_ENV === 'development'  →  pass through (no-op)
 *
 * Do NOT add exceptions. Do NOT add a flag to re-enable in production.
 * If you need a production-safe admin surface, create a separate, authenticated
 * route that is explicitly designed for production use.
 */

import { NextRequest, NextResponse } from 'next/server';

// Paths that are dev-only. All sub-paths are blocked automatically via prefix
// matching in the matcher config below.
const DEV_ONLY_PREFIXES = ['/admin', '/api/admin'];

export function middleware(request: NextRequest): NextResponse | undefined {
  const { pathname } = request.nextUrl;

  const isDevOnlyRoute = DEV_ONLY_PREFIXES.some((prefix) =>
    pathname === prefix || pathname.startsWith(prefix + '/'),
  );

  if (isDevOnlyRoute && process.env.NODE_ENV !== 'development') {
    // Return a plain 404 — do not reveal that the route exists or why it's
    // blocked. This prevents enumeration of internal tooling paths.
    return new NextResponse(null, { status: 404 });
  }

  // All other routes: pass through.
  return undefined;
}

export const config = {
  // Run only on admin routes — avoid adding overhead to every request.
  matcher: ['/admin', '/admin/:path*', '/api/admin', '/api/admin/:path*'],
};
