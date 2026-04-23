/**
 * GET /api/readyz
 *
 * Readiness probe. Validates critical dependencies before declaring the
 * instance ready to serve traffic.
 *
 * Checks:
 * - Read-only DB is accessible (opens connection, runs SELECT 1, closes)
 *
 * Response:
 * - 200 { status: "ok" }          - all dependencies healthy
 * - 503 { status: "unavailable", reason: "<string>" } - dependency failure
 *
 * PUBLIC_SURFACE: no auth required - registered in PUBLIC_ROUTES (config.ts)
 */
import { NextResponse } from 'next/server';
import { checkDbReady } from '@/lib/db-init';

export const dynamic = 'force-dynamic';

export function GET(): NextResponse {
  const probe = checkDbReady();

  if (!probe.ok) {
    return NextResponse.json(
      { status: 'unavailable', reason: probe.reason ?? 'db_probe_failed' },
      { status: 503 },
    );
  }

  return NextResponse.json({ status: 'ok' }, { status: 200 });
}
