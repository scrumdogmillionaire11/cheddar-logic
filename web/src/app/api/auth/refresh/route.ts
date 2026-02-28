import { NextRequest, NextResponse } from 'next/server';
import { closeDatabase, initDb } from '@cheddar-logic/data';
import {
  REFRESH_COOKIE_NAME,
  refreshAccessTokenFromRefreshToken,
  setAuthCookies,
} from '@/lib/auth/server';

export async function POST(request: NextRequest) {
  try {
    await initDb();

    const refreshToken = request.cookies.get(REFRESH_COOKIE_NAME)?.value;
    if (!refreshToken) {
      return NextResponse.json({ error: 'No refresh token' }, { status: 401 });
    }

    const result = refreshAccessTokenFromRefreshToken(refreshToken);
    if (!result) {
      return NextResponse.json({ error: 'Invalid or expired refresh token' }, { status: 401 });
    }

    const response = NextResponse.json({ ok: true });
    setAuthCookies(response, result.accessToken, result.refreshToken);
    return response;
  } catch (err) {
    console.error('[Auth] Refresh failed:', err);
    return NextResponse.json({ error: 'Refresh failed' }, { status: 500 });
  } finally {
    closeDatabase();
  }
}
