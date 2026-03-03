/**
 * GET /api/auth/token
 * Development endpoint to generate test tokens
 * 
 * Query parameters:
 * - role: ADMIN | PAID | FREE_ACCOUNT (default: FREE_ACCOUNT)
 * - subscription: NONE | TRIAL | ACTIVE | PAST_DUE (default: NONE)
 * - email: email address (default: test@example.com)
 * - userId: user ID (default: test-user-123)
 * 
 * Example: http://localhost:3000/api/auth/token?role=PAID&subscription=ACTIVE&email=user@example.com
 * 
 * SECURITY: Remove or restrict this endpoint in production!
 */

import { NextRequest, NextResponse } from 'next/server';
import { createAccessToken } from '../../../../lib/api-security/jwt';
import { performSecurityChecks, addRateLimitHeaders } from '../../../../lib/api-security';
import auditLogger from '../../../../lib/api-security/audit-logger';
import { AuditEventType } from '../../../../lib/api-security/event-types';
import { getClientIp } from '../../../../lib/api-security/rate-limiter';

type RoleType = 'ADMIN' | 'PAID' | 'FREE_ACCOUNT';
type SubscriptionType = 'NONE' | 'TRIAL' | 'ACTIVE' | 'PAST_DUE';

export async function GET(request: NextRequest) {
  try {
    // Note: Still apply rate limiting even for token generation
    const securityCheck = performSecurityChecks(request, '/api/auth/token');
    if (!securityCheck.allowed) {
      return securityCheck.error!;
    }

    // TODO: Remove this in production or add IP whitelist
    const isDevelopment = process.env.NODE_ENV === 'development';
    if (!isDevelopment) {
      return NextResponse.json(
        { success: false, error: 'Token generation not available in production' },
        { status: 403 }
      );
    }

    const { searchParams } = request.nextUrl;
    const role = (searchParams.get('role') || 'FREE_ACCOUNT') as RoleType;
    const subscription_status = (searchParams.get('subscription') || 'NONE') as SubscriptionType;
    const email = searchParams.get('email') || 'test@example.com';
    const userId = searchParams.get('userId') || 'test-user-123';

    // Validate role
    const validRoles: RoleType[] = ['ADMIN', 'PAID', 'FREE_ACCOUNT'];
    if (!validRoles.includes(role)) {
      return NextResponse.json(
        { success: false, error: `Invalid role. Must be one of: ${validRoles.join(', ')}` },
        { status: 400 }
      );
    }

    // Validate subscription status
    const validStatuses: SubscriptionType[] = ['NONE', 'TRIAL', 'ACTIVE', 'PAST_DUE'];
    if (!validStatuses.includes(subscription_status)) {
      return NextResponse.json(
        {
          success: false,
          error: `Invalid subscription. Must be one of: ${validStatuses.join(', ')}`,
        },
        { status: 400 }
      );
    }

    // Generate token
    const token = createAccessToken({
      userId,
      email,
      role,
      subscription_status,
      flags: ['DEVELOPER'],
    });

    // Log token generation
    const clientIp = getClientIp(request);
    auditLogger.logEvent(AuditEventType.AUTH_TOKEN_GENERATED, clientIp, {
      userId,
      email,
      endpoint: '/api/auth/token',
      method: 'GET',
      userAgent: request.headers.get('user-agent') || undefined,
      details: {
        role,
        subscription_status,
      },
    });

    const response = NextResponse.json(
      {
        success: true,
        token,
        expires_in: 900, // 15 minutes
        token_type: 'Bearer',
        user: {
          id: userId,
          email,
          role,
          subscription_status,
        },
        usage: {
          header: `Authorization: Bearer ${token}`,
          curl: `curl -H "Authorization: Bearer ${token}" http://localhost:3000/api/games`,
        },
      },
      { headers: { 'Content-Type': 'application/json' } }
    );

    return addRateLimitHeaders(response, request);
  } catch (error) {
    console.error('[API] Error generating token:', error);
    const message = error instanceof Error ? error.message : 'Unknown error';
    const response = NextResponse.json(
      { success: false, error: message },
      { status: 500 }
    );
    return addRateLimitHeaders(response, request);
  }
}
