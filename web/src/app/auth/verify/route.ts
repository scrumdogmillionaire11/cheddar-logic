import { NextRequest, NextResponse } from 'next/server';
import { closeDatabase, initDb, RESOURCE } from '@cheddar-logic/data';
import {
  ACCESS_COOKIE_NAME,
  consumeMagicLinkAndCreateSession,
  getAccessTokenAuthResult,
  sanitizeNextPath,
  setAuthCookies,
} from '@/lib/auth/server';

export async function GET(request: NextRequest) {
  const token = request.nextUrl.searchParams.get('token');
  const code = request.nextUrl.searchParams.get('code');
  const next = sanitizeNextPath(request.nextUrl.searchParams.get('next'));

  if (!token || !code) {
    const invalidUrl = new URL('/login?error=invalid_link', request.url);
    return NextResponse.redirect(invalidUrl);
  }

  try {
    await initDb();

    // Check if user already has a valid session - if so, just redirect
    // This prevents the "link already used" error when clicking the same link twice
    const existingToken = request.cookies.get(ACCESS_COOKIE_NAME)?.value;
    if (existingToken) {
      const auth = getAccessTokenAuthResult(existingToken, RESOURCE.CHEDDAR_BOARD);
      if (auth.isAuthenticated && auth.isEntitled) {
        console.log('[Auth] User already has valid session, skipping magic link consumption');
        const redirectUrl = new URL(next, request.url);
        return NextResponse.redirect(redirectUrl);
      }
    }

    const session = consumeMagicLinkAndCreateSession(request, token, code);
    const redirectUrl = new URL(next, request.url);
    const response = NextResponse.redirect(redirectUrl);
    setAuthCookies(response, session.accessToken, session.refreshToken);
    return response;
    } catch (err) {
      console.error('[Auth] Magic link verify failed:', err);
    const failureUrl = new URL('/login?error=expired_or_used', request.url);
    return NextResponse.redirect(failureUrl);
  } finally {
    closeDatabase();
  }
}
