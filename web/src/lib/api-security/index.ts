/**
 * Combined security wrapper for API routes
 * Handles rate limiting, validation, error responses, and authentication
 */

import { NextResponse, type NextRequest } from 'next/server';
import { checkRateLimit } from './rate-limiter';
import { validateQueryParams, validateRequestSize, createValidationErrorResponse } from './validation';

export interface SecurityCheckResult {
  allowed: boolean;
  error?: NextResponse;
}

const rateLimitCache = new WeakMap<Request, ReturnType<typeof checkRateLimit>>();

/**
 * Perform all security checks on incoming request
 * @param request - Next.js Request object
 * @param routePath - API route path (e.g., '/api/games')
 * @returns SecurityCheckResult with optional error response
 */
export function performSecurityChecks(
  request: NextRequest,
  routePath: string
): SecurityCheckResult {
  // Check 1: Rate limiting
  const rateLimitResult = checkRateLimit(request);
  rateLimitCache.set(request, rateLimitResult);
  if (!rateLimitResult.allowed) {
    const retryAfterSeconds = Math.max(
      1,
      Math.ceil((rateLimitResult.resetTime - Date.now()) / 1000)
    );
    const response = NextResponse.json(
      {
        success: false,
        error: 'Rate limit exceeded',
        retryAfter: retryAfterSeconds,
      },
      { status: 429 }
    );

    // Add rate limit headers
    Object.entries(rateLimitResult.headers).forEach(([key, value]) => {
      response.headers.set(key, value);
    });
    response.headers.set('Retry-After', retryAfterSeconds.toString());

    return { allowed: false, error: response };
  }

  // Check 2: Request size
  if (!validateRequestSize(request)) {
    return {
      allowed: false,
      error: NextResponse.json(
        {
          success: false,
          error: 'Request body too large (max 1MB)',
        },
        { status: 413 }
      ),
    };
  }

  // Check 3: Query parameters validation
  const url = new URL(request.url);
  const queryParams: Record<string, string | string[]> = {};
  url.searchParams.forEach((value, key) => {
    if (queryParams[key]) {
      // Convert to array if multiple values
      if (Array.isArray(queryParams[key])) {
        (queryParams[key] as string[]).push(value);
      } else {
        queryParams[key] = [queryParams[key] as string, value];
      }
    } else {
      queryParams[key] = value;
    }
  });

  if (Object.keys(queryParams).length > 0) {
    const validation = validateQueryParams(routePath, queryParams);
    if (!validation.valid) {
      return {
        allowed: false,
        error: NextResponse.json(
          createValidationErrorResponse(validation.errors),
          { status: 400 }
        ),
      };
    }
  }

  return { allowed: true };
}

/**
 * Helper to add rate limit headers to any response
 */
export function addRateLimitHeaders(response: NextResponse, request: NextRequest): NextResponse {
  const rateLimitResult = rateLimitCache.get(request) ?? checkRateLimit(request);
  rateLimitCache.delete(request);
  Object.entries(rateLimitResult.headers).forEach(([key, value]) => {
    response.headers.set(key, value);
  });
  return response;
}

// Re-export auth utilities
export * from './jwt';
export * from './auth';
export * from './config';

// Re-export security headers utilities
export * from './security-headers';

// Re-export audit logging utilities
export * from './audit-logger';
export * from './event-types';
