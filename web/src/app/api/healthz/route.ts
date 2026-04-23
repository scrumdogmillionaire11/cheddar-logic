/**
 * GET /api/healthz
 *
 * Liveness probe. Confirms the Node.js process is alive and the
 * Next.js runtime is serving requests. No DB or external dependency
 * is touched - this endpoint must always return 200 as long as the
 * process is running.
 *
 * Response: 200 { status: "ok" }
 *
 * PUBLIC_SURFACE: no auth required - registered in PUBLIC_ROUTES (config.ts)
 */
import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

export function GET(): NextResponse {
  return NextResponse.json({ status: 'ok' }, { status: 200 });
}
