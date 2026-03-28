import { NextRequest, NextResponse } from 'next/server';
import { closeDatabaseReadOnly } from '@cheddar-logic/data';
import { ensureDbReady } from '@/lib/db-init';
import {
  addRateLimitHeaders,
  performSecurityChecks,
} from '@/lib/api-security';
import { revokeRefreshToken } from '@/lib/api-security/jwt';

const AUTH_COOKIE_NAMES = ['cheddar_access_token', 'cheddar_refresh_token'] as const;

function clearAuthCookies(response: NextResponse) {
  const secure = process.env.NODE_ENV === 'production';

  for (const cookieName of AUTH_COOKIE_NAMES) {
    response.cookies.set({
      name: cookieName,
      value: '',
      httpOnly: true,
      sameSite: 'lax',
      secure,
      path: '/',
      maxAge: 0,
    });
  }
}

async function readOptionalJsonBody(
  request: NextRequest,
): Promise<{ refreshToken?: string } | null> {
  try {
    return (await request.json()) as { refreshToken?: string };
  } catch {
    return null;
  }
}

function extractRefreshToken(
  request: NextRequest,
  body: { refreshToken?: string } | null,
): string | null {
  const cookieToken = request.cookies.get('cheddar_refresh_token')?.value?.trim();
  if (cookieToken) return cookieToken;

  const headerToken = request.headers.get('x-refresh-token')?.trim();
  if (headerToken) return headerToken;

  const bodyToken =
    typeof body?.refreshToken === 'string' ? body.refreshToken.trim() : '';
  return bodyToken || null;
}

export async function POST(request: NextRequest) {
  try {
    const securityCheck = performSecurityChecks(request, '/api/auth/logout');
    if (!securityCheck.allowed) {
      return addRateLimitHeaders(securityCheck.error!, request);
    }

    await ensureDbReady();

    const body = await readOptionalJsonBody(request);
    const refreshToken = extractRefreshToken(request, body);

    if (refreshToken) {
      revokeRefreshToken(refreshToken);
    }

    const response = NextResponse.json({
      success: true,
    });
    clearAuthCookies(response);
    return addRateLimitHeaders(response, request);
  } catch (error) {
    console.error('[AUTH] Logout failed:', error);
    const message = error instanceof Error ? error.message : 'Unknown error';
    const response = NextResponse.json(
      { success: false, error: message },
      { status: 500 },
    );
    clearAuthCookies(response);
    return addRateLimitHeaders(response, request);
  } finally {
    closeDatabaseReadOnly();
  }
}
