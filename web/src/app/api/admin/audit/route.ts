/**
 * GET /api/admin/audit
 *
 * Development-only endpoint for viewing audit logs and security events.
 * Requires NODE_ENV=development to access.
 *
 * Query parameters:
 * - eventType: Filter by event type
 * - severity: Filter by severity (INFO, WARN, ERROR, CRITICAL)
 * - clientIp: Filter by client IP
 * - limit: Number of events to return (default 100, max 1000)
 * - timeWindow: Hours to look back (default 1, max 24)
 *
 * Response:
 * {
 *   success: boolean,
 *   data: {
 *     events: AuditEvent[],
 *     statistics: {
 *       totalInWindow: number,
 *       totalBySeverity: Record<string, number>,
 *       topClientIps: Array<{ip: string, count: number}>,
 *       suspiciousPatterns: Array<{ip: string, pattern: string}>
 *     }
 *   },
 *   error?: string
 * }
 */

import { NextResponse, NextRequest } from 'next/server';
import auditLogger from '../../../../lib/api-security/audit-logger';
import {
  AuditEventType,
  AuditEventSeverity,
} from '../../../../lib/api-security/event-types';

export async function GET(request: NextRequest) {
  // Admin secret gate (behind ENABLE_AUTH_WALLS — not yet active)
  if (process.env.ENABLE_AUTH_WALLS === 'true') {
    const adminSecret = process.env.ADMIN_API_SECRET;
    const providedSecret = request.headers.get('x-admin-secret');
    if (!adminSecret || providedSecret !== adminSecret) {
      return NextResponse.json(
        { success: false, error: 'Forbidden' },
        { status: 403 },
      );
    }
  }

  // Development-only endpoint
  if (process.env.NODE_ENV !== 'development') {
    return NextResponse.json(
      {
        success: false,
        error: 'Audit endpoint only available in development',
      },
      { status: 403, headers: { 'Content-Type': 'application/json' } },
    );
  }

  try {
    const { searchParams } = new URL(request.url);

    // Parse query parameters
    const eventType = searchParams.get('eventType') as AuditEventType | null;
    const severity = searchParams.get('severity') as AuditEventSeverity | null;
    const clientIp = searchParams.get('clientIp');
    const limit = Math.min(parseInt(searchParams.get('limit') || '100'), 1000);
    const timeWindowHours = Math.min(
      parseInt(searchParams.get('timeWindow') || '1'),
      24,
    );
    const timeWindowMs = timeWindowHours * 60 * 60 * 1000;

    // Get events with filters
    const events = auditLogger.getEvents({
      eventType: eventType || undefined,
      severity: severity || undefined,
      clientIp: clientIp || undefined,
      startTime: Date.now() - timeWindowMs,
      limit,
    });

    // Generate report
    const report = auditLogger.generateReport(timeWindowMs);

    // Detect suspicious IPs
    const suspiciousIps = Array.from(
      new Set(events.map((e: { clientIp: string }) => e.clientIp)),
    ).map((ip) => {
      const patterns = auditLogger.detectSuspiciousPatterns(ip, 5 * 60 * 1000);
      return {
        ip,
        ...patterns,
      };
    });

    const response = NextResponse.json(
      {
        success: true,
        data: {
          events,
          statistics: {
            totalInWindow: report.totalEvents,
            totalBySeverity: report.bySeverity,
            topClientIps: report.topClientIps,
            suspiciousPatterns: suspiciousIps.filter((ip) => ip.isSuspicious),
          },
          meta: {
            timeWindow: `${timeWindowHours}h`,
            eventTypes: Object.values(AuditEventType),
            severityLevels: Object.values(AuditEventSeverity),
          },
        },
      },
      { headers: { 'Content-Type': 'application/json' } },
    );

    return response;
  } catch (error) {
    console.error('[API] Error fetching audit logs:', error);
    const message = error instanceof Error ? error.message : 'Unknown error';

    return NextResponse.json(
      {
        success: false,
        error: `Failed to fetch audit data: ${message}`,
      },
      { status: 500, headers: { 'Content-Type': 'application/json' } },
    );
  }
}
