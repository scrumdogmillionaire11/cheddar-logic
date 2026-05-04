/**
 * GET /api/readyz
 *
 * Readiness probe. Validates DB reachability and required schema contracts
 * for all enabled web surfaces before declaring the instance ready.
 *
 * Response:
 * - 200 { ok: true, ready: true, db, contracts }   - all contracts satisfied
 * - 503 { ok: false, ready: false, db, contracts } - DB unreachable or schema failure
 *
 * PUBLIC_SURFACE: no auth required - registered in PUBLIC_ROUTES (config.ts)
 */
import { NextResponse } from 'next/server';
import { checkDbReady } from '@/lib/db-init';

export const dynamic = 'force-dynamic';

export function GET(): NextResponse {
  const result = checkDbReady();
  return NextResponse.json(result, { status: result.ready ? 200 : 503 });
}
