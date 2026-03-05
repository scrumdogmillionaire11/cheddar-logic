/**
 * Audit Logger
 *
 * Logs security events (auth attempts, rate limit violations, injection attempts, etc.)
 * for monitoring, alerting, and compliance purposes.
 *
 * Features:
 * - In-memory event store (similar to rate limiter)
 * - Automatic cleanup of old events
 * - Query and filtering capabilities
 * - Event severity tracking
 * - Suspicious pattern detection
 */

import {
  AuditEventType,
  AuditEventSeverity,
  EVENT_SEVERITY_MAP,
  EVENT_DESCRIPTION_MAP,
} from './event-types';
import { SECURITY_CONFIG } from './config';

export interface AuditEvent {
  id: string;
  eventType: AuditEventType;
  severity: AuditEventSeverity;
  timestamp: number;
  clientIp: string;
  userId?: string;
  email?: string;
  endpoint?: string;
  method?: string;
  userAgent?: string;
  details?: Record<string, unknown>;
  description: string;
}

interface AuditEventStore {
  [eventId: string]: AuditEvent;
}

/**
 * In-memory audit logger (singleton)
 */
class AuditLogger {
  private events: AuditEventStore = {};
  private eventCount = 0;
  private maxEvents = 10000; // Keep max 10k events in memory
  private cleanupInterval = 5 * 60 * 1000; // Cleanup every 5 minutes
  private maxEventAge = 24 * 60 * 60 * 1000; // Keep events for 24 hours

  constructor() {
    // Auto-cleanup old events
    setInterval(() => this.cleanup(), this.cleanupInterval);
  }

  /**
   * Log an audit event
   */
  logEvent(
    eventType: AuditEventType,
    clientIp: string,
    options?: {
      userId?: string;
      email?: string;
      endpoint?: string;
      method?: string;
      userAgent?: string;
      details?: Record<string, unknown>;
    },
  ): AuditEvent {
    const eventId = `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    const severity = EVENT_SEVERITY_MAP[eventType];
    const description = EVENT_DESCRIPTION_MAP[eventType];

    const event: AuditEvent = {
      id: eventId,
      eventType,
      severity,
      timestamp: Date.now(),
      clientIp,
      userId: options?.userId,
      email: options?.email,
      endpoint: options?.endpoint,
      method: options?.method,
      userAgent: options?.userAgent,
      details: options?.details,
      description,
    };

    if (!SECURITY_CONFIG.auditLogging) {
      return event;
    }

    this.events[eventId] = event;
    this.eventCount++;

    // Enforce max events limit
    if (this.eventCount > this.maxEvents) {
      this.cleanup();
    }

    return event;
  }

  /**
   * Get all events with optional filtering
   */
  getEvents(filters?: {
    eventType?: AuditEventType;
    severity?: AuditEventSeverity;
    clientIp?: string;
    userId?: string;
    startTime?: number;
    endTime?: number;
    limit?: number;
  }): AuditEvent[] {
    if (!SECURITY_CONFIG.auditLogging) {
      return [];
    }

    let events = Object.values(this.events);

    if (filters?.eventType) {
      events = events.filter((e) => e.eventType === filters.eventType);
    }

    if (filters?.severity) {
      events = events.filter((e) => e.severity === filters.severity);
    }

    if (filters?.clientIp) {
      events = events.filter((e) => e.clientIp === filters.clientIp);
    }

    if (filters?.userId) {
      events = events.filter((e) => e.userId === filters.userId);
    }

    if (filters?.startTime) {
      events = events.filter((e) => e.timestamp >= filters.startTime!);
    }

    if (filters?.endTime) {
      events = events.filter((e) => e.timestamp <= filters.endTime!);
    }

    // Sort by timestamp descending (newest first)
    events.sort((a, b) => b.timestamp - a.timestamp);

    // Apply limit
    if (filters?.limit) {
      events = events.slice(0, filters.limit);
    }

    return events;
  }

  /**
   * Get events for a specific client IP
   */
  getClientEvents(clientIp: string, limit = 100): AuditEvent[] {
    if (!SECURITY_CONFIG.auditLogging) {
      return [];
    }

    return this.getEvents({ clientIp, limit });
  }

  /**
   * Get all critical/high severity events
   */
  getCriticalEvents(limit = 50): AuditEvent[] {
    if (!SECURITY_CONFIG.auditLogging) {
      return [];
    }

    const critical = this.getEvents({
      severity: AuditEventSeverity.CRITICAL,
      limit,
    });

    const errors = this.getEvents({
      severity: AuditEventSeverity.ERROR,
      limit,
    });

    // Combine and deduplicate
    const combined = [...critical, ...errors];
    combined.sort((a, b) => b.timestamp - a.timestamp);
    return combined.slice(0, limit);
  }

  /**
   * Detect suspicious patterns for an IP
   */
  detectSuspiciousPatterns(
    clientIp: string,
    windowMs = 5 * 60 * 1000,
  ): {
    totalEvents: number;
    authFailures: number;
    rateLimitViolations: number;
    validationErrors: number;
    injectionAttempts: number;
    isSuspicious: boolean;
  } {
    if (!SECURITY_CONFIG.auditLogging) {
      return {
        totalEvents: 0,
        authFailures: 0,
        rateLimitViolations: 0,
        validationErrors: 0,
        injectionAttempts: 0,
        isSuspicious: false,
      };
    }

    const now = Date.now();
    const clientEvents = this.getClientEvents(clientIp, 1000);
    const recentEvents = clientEvents.filter(
      (e) => now - e.timestamp < windowMs,
    );

    const authFailures = recentEvents.filter((e) =>
      [
        AuditEventType.AUTH_TOKEN_INVALID,
        AuditEventType.AUTH_TOKEN_EXPIRED,
        AuditEventType.AUTH_MISSING,
      ].includes(e.eventType),
    ).length;

    const rateLimitViolations = recentEvents.filter(
      (e) => e.eventType === AuditEventType.RATE_LIMIT_EXCEEDED,
    ).length;

    const validationErrors = recentEvents.filter(
      (e) =>
        e.eventType === AuditEventType.VALIDATION_ERROR ||
        e.eventType === AuditEventType.INVALID_QUERY_PARAM,
    ).length;

    const injectionAttempts = recentEvents.filter((e) =>
      [
        AuditEventType.SQL_INJECTION_ATTEMPT,
        AuditEventType.SUSPICIOUS_SQL_PATTERN,
      ].includes(e.eventType),
    ).length;

    const isSuspicious =
      rateLimitViolations > 3 ||
      authFailures > 5 ||
      injectionAttempts > 0 ||
      validationErrors > 10;

    return {
      totalEvents: recentEvents.length,
      authFailures,
      rateLimitViolations,
      validationErrors,
      injectionAttempts,
      isSuspicious,
    };
  }

  /**
   * Generate audit report summary
   */
  generateReport(timeWindowMs = 60 * 60 * 1000): {
    timePeriod: string;
    totalEvents: number;
    bySeverity: Record<string, number>;
    byEventType: Record<string, number>;
    topClientIps: Array<{ ip: string; count: number }>;
    criticalEvents: AuditEvent[];
  } {
    if (!SECURITY_CONFIG.auditLogging) {
      const hours = Math.round(timeWindowMs / (60 * 60 * 1000));
      return {
        timePeriod: `Last ${hours} hour${hours !== 1 ? 's' : ''}`,
        totalEvents: 0,
        bySeverity: {},
        byEventType: {},
        topClientIps: [],
        criticalEvents: [],
      };
    }

    const now = Date.now();
    const startTime = now - timeWindowMs;

    const events = this.getEvents({ startTime, limit: 10000 });

    const bySeverity: Record<string, number> = {};
    const byEventType: Record<string, number> = {};
    const ipCounts: Record<string, number> = {};

    for (const event of events) {
      bySeverity[event.severity] = (bySeverity[event.severity] || 0) + 1;
      byEventType[event.eventType] = (byEventType[event.eventType] || 0) + 1;
      ipCounts[event.clientIp] = (ipCounts[event.clientIp] || 0) + 1;
    }

    const topClientIps = Object.entries(ipCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([ip, count]) => ({ ip, count }));

    const criticalEvents = events.filter(
      (e) =>
        e.severity === AuditEventSeverity.CRITICAL ||
        e.severity === AuditEventSeverity.ERROR,
    );

    const hours = Math.round(timeWindowMs / (60 * 60 * 1000));

    return {
      timePeriod: `Last ${hours} hour${hours !== 1 ? 's' : ''}`,
      totalEvents: events.length,
      bySeverity,
      byEventType,
      topClientIps,
      criticalEvents: criticalEvents.slice(0, 50),
    };
  }

  /**
   * Cleanup old events (older than maxEventAge)
   */
  private cleanup(): void {
    if (!SECURITY_CONFIG.auditLogging) {
      return;
    }

    const now = Date.now();
    const oldestAllowed = now - this.maxEventAge;

    const idsToDelete = Object.entries(this.events)
      .filter(([, event]) => event.timestamp < oldestAllowed)
      .map(([id]) => id);

    for (const id of idsToDelete) {
      delete this.events[id];
      this.eventCount--;
    }

    console.log(`[Audit] Cleanup: removed ${idsToDelete.length} old events`);
  }

  /**
   * Clear all events (for testing/admin purposes)
   */
  clearAllEvents(): number {
    if (!SECURITY_CONFIG.auditLogging) {
      return 0;
    }

    const count = Object.keys(this.events).length;
    this.events = {};
    this.eventCount = 0;
    return count;
  }

  /**
   * Get current event count
   */
  getEventCount(): number {
    if (!SECURITY_CONFIG.auditLogging) {
      return 0;
    }

    return this.eventCount;
  }
}

// Singleton instance
const auditLogger = new AuditLogger();

export default auditLogger;
