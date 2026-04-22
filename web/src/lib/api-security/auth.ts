/**
 * Authentication Middleware for API Routes
 * Handles token validation, user context, and entitlement checks
 */

import { NextRequest, NextResponse } from 'next/server';
import { verifyToken, extractTokenFromHeader, type AuthToken } from './jwt';
import auditLogger from './audit-logger';
import { AuditEventType } from './event-types';
import { getClientIp } from './rate-limiter';
import { isApiAuthEnforced } from './config';

export interface AuthContext {
  user: AuthToken | null;
  authenticated: boolean;
  error?: string;
}

/**
 * Verify Bearer token from request
 */
export function verifyRequestToken(request: NextRequest): AuthContext {
  const clientIp = getClientIp(request);

  try {
    const authHeader = request.headers.get('Authorization');
    const token = extractTokenFromHeader(authHeader);

    if (!token) {
      auditLogger.logEvent(AuditEventType.AUTH_MISSING, clientIp, {
        endpoint: request.nextUrl.pathname,
        method: request.method,
        userAgent: request.headers.get('user-agent') || undefined,
      });

      return {
        user: null,
        authenticated: false,
        error: 'No authorization token provided',
      };
    }

    const claims = verifyToken(token);
    if (!claims) {
      auditLogger.logEvent(AuditEventType.AUTH_TOKEN_INVALID, clientIp, {
        endpoint: request.nextUrl.pathname,
        method: request.method,
        userAgent: request.headers.get('user-agent') || undefined,
      });

      return {
        user: null,
        authenticated: false,
        error: 'Invalid or expired token',
      };
    }

    auditLogger.logEvent(AuditEventType.AUTH_TOKEN_VALID, clientIp, {
      userId: claims.userId,
      email: claims.email,
      endpoint: request.nextUrl.pathname,
      method: request.method,
      userAgent: request.headers.get('user-agent') || undefined,
      details: {
        role: claims.role,
        subscription: claims.subscription_status,
      },
    });

    return {
      user: claims,
      authenticated: true,
    };
  } catch (error) {
    console.error('[AUTH] Token verification error:', error);

    auditLogger.logEvent(AuditEventType.AUTH_TOKEN_INVALID, clientIp, {
      endpoint: request.nextUrl.pathname,
      method: request.method,
      userAgent: request.headers.get('user-agent') || undefined,
      details: {
        error: error instanceof Error ? error.message : 'Unknown error',
      },
    });

    return {
      user: null,
      authenticated: false,
      error: 'Authentication check failed',
    };
  }
}

export type ResourceType = 'CHEDDAR_BOARD' | 'FPL_SAGE' | 'ADMIN_PANEL';

export const RESOURCE: Record<ResourceType, ResourceType> = {
  CHEDDAR_BOARD: 'CHEDDAR_BOARD',
  FPL_SAGE: 'FPL_SAGE',
  ADMIN_PANEL: 'ADMIN_PANEL',
};

const RESOURCE_ROLES: Record<ResourceType, Set<string>> = {
  CHEDDAR_BOARD: new Set(['ADMIN', 'PAID', 'FREE_ACCOUNT']),
  FPL_SAGE: new Set(['ADMIN', 'PAID']),
  ADMIN_PANEL: new Set(['ADMIN']),
};

/**
 * Check if user has required role for resource
 */
export function hasRequiredRole(
  user: AuthToken | null,
  resource: ResourceType,
): boolean {
  if (!user) return false;

  const allowedRoles = RESOURCE_ROLES[resource] || new Set();
  return allowedRoles.has(user.role);
}

/**
 * Check if user has subscription for premium features
 */
export function hasActiveSubscription(user: AuthToken | null): boolean {
  if (!user) return false;

  const status = user.subscription_status;
  return status === 'ACTIVE' || status === 'TRIAL';
}

/**
 * Check if user has flag (admin feature flags, comped access, etc.)
 */
export function hasFlag(user: AuthToken | null, flag: string): boolean {
  if (!user || !user.flags) return false;
  return user.flags.includes(flag);
}

/**
 * Create 401 Unauthorized response
 */
export function createUnauthorizedResponse(
  message = 'Unauthorized',
): NextResponse {
  return NextResponse.json(
    {
      success: false,
      error: message,
    },
    {
      status: 401,
      headers: {
        'WWW-Authenticate': 'Bearer realm="API"',
      },
    },
  );
}

/**
 * Create 403 Forbidden response
 */
export function createForbiddenResponse(
  message = 'Insufficient permissions',
): NextResponse {
  return NextResponse.json(
    {
      success: false,
      error: message,
    },
    { status: 403 },
  );
}

/**
 * Require authentication middleware
 * Use in protected routes
 */
export function requireAuth(request: NextRequest): {
  context: AuthContext;
  error?: NextResponse;
} {
  const context = verifyRequestToken(request);

  if (!context.authenticated || !context.user) {
    return {
      context,
      error: createUnauthorizedResponse(
        context.error || 'Authentication required',
      ),
    };
  }

  return { context };
}

/**
 * Require specific role/resource access
 */
export function requireRole(
  request: NextRequest,
  resource: ResourceType,
): { context: AuthContext; error?: NextResponse } {
  const { context, error: authError } = requireAuth(request);

  if (authError) {
    return { context, error: authError };
  }

  if (!hasRequiredRole(context.user, resource)) {
    const clientIp = getClientIp(request);
    auditLogger.logEvent(AuditEventType.AUTH_ROLE_DENIED, clientIp, {
      userId: context.user?.userId,
      email: context.user?.email,
      endpoint: request.nextUrl.pathname,
      method: request.method,
      userAgent: request.headers.get('user-agent') || undefined,
      details: {
        resource,
        userRole: context.user?.role,
        requiredRoles: Array.from(RESOURCE_ROLES[resource] || []),
      },
    });

    return {
      context,
      error: createForbiddenResponse(
        `This endpoint requires ${resource} access. Your role: ${context.user?.role || 'unknown'}`,
      ),
    };
  }

  return { context };
}

/**
 * Require entitlement for a resource — simplified gate for API route handlers.
 * Returns { ok, error, status } instead of a NextResponse so callers can
 * construct their own response shape.
 */
export function requireEntitlementForRequest(
  request: NextRequest,
  resource: ResourceType,
): { ok: boolean; error: string; status: number } {
  if (!isApiAuthEnforced()) {
    return { ok: true, error: '', status: 200 };
  }

  const context = verifyRequestToken(request);

  if (!context.authenticated || !context.user) {
    return {
      ok: false,
      error: context.error || 'Authentication required',
      status: 401,
    };
  }

  if (!hasRequiredRole(context.user, resource)) {
    const clientIp = getClientIp(request);
    auditLogger.logEvent(AuditEventType.AUTH_ROLE_DENIED, clientIp, {
      userId: context.user.userId,
      email: context.user.email,
      endpoint: request.nextUrl.pathname,
      method: request.method,
      userAgent: request.headers.get('user-agent') || undefined,
      details: {
        resource,
        userRole: context.user.role,
        requiredRoles: Array.from(RESOURCE_ROLES[resource] || []),
      },
    });
    return {
      ok: false,
      error: `This endpoint requires ${resource} access. Your role: ${context.user.role || 'unknown'}`,
      status: 403,
    };
  }

  return { ok: true, error: '', status: 200 };
}

/**
 * Optional authentication - don't fail if missing token,
 * but validate if token is present
 */
export function optionalAuth(request: NextRequest): AuthContext {
  const authHeader = request.headers.get('Authorization');

  // No token provided - that's ok for optional auth
  if (!authHeader) {
    return {
      user: null,
      authenticated: false,
    };
  }

  // Token provided - validate it
  return verifyRequestToken(request);
}
