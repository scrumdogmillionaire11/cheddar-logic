import { NextResponse } from 'next/server';
import auditLogger from './audit-logger';
import { AuditEventType } from './event-types';
import { resolveClientIp } from './rate-limiter';

function parseAllowedTokenRouteIps(
  rawValue: string | undefined,
): Set<string> {
  return new Set(
    (rawValue || '')
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean),
  );
}

function createForbiddenResponse() {
  return NextResponse.json(
    {
      success: false,
      error: 'Forbidden',
    },
    { status: 403 },
  );
}

export function checkTokenRouteAllowlist(
  request: Request,
): NextResponse | null {
  if (process.env.NODE_ENV === 'development') {
    return null;
  }

  const ipResolution = resolveClientIp(request);
  const clientIp = ipResolution.clientIp;
  const allowedIps = parseAllowedTokenRouteIps(
    process.env.TOKEN_ROUTE_ALLOWED_IPS,
  );
  const allowlistConfigured = allowedIps.size > 0;
  const clientIpKnown = !clientIp.startsWith('unknown:');
  const clientAllowed =
    allowlistConfigured && clientIpKnown && allowedIps.has(clientIp);

  if (clientAllowed) {
    return null;
  }

  auditLogger.logEvent(AuditEventType.SUSPICIOUS_REQUEST, clientIp, {
    endpoint: '/api/auth/token',
    method: request.method,
    userAgent: request.headers.get('user-agent') || undefined,
    details: {
      allowlistConfigured,
      reason: !allowlistConfigured
        ? 'allowlist_missing'
        : ipResolution.forwardedChainRejected
          ? 'untrusted_forwarded_chain'
          : clientIpKnown
            ? 'ip_not_allowed'
            : 'client_ip_unknown',
      forwardedChainRejected: ipResolution.forwardedChainRejected,
    },
  });

  return createForbiddenResponse();
}