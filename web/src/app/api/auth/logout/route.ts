import { NextRequest, NextResponse } from 'next/server';
import { closeDatabase, initDb } from '@cheddar-logic/data';
import { clearAuthCookies, REFRESH_COOKIE_NAME, revokeSessionByRefreshToken } from '@/lib/auth/server';

export async function POST(request: NextRequest) {
  try {
    await initDb();
    const refreshToken = request.cookies.get(REFRESH_COOKIE_NAME)?.value;
    revokeSessionByRefreshToken(refreshToken);

    const response = NextResponse.json({ success: true });
    clearAuthCookies(response);
    return response;
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  } finally {
    closeDatabase();
  }
}
