/**
 * In-memory rate limiter using sliding window algorithm
 * Tracks requests by IP address
 *
 * For production, consider Redis-based implementation for distributed systems
 */

interface RateLimitEntry {
  timestamps: number[];
  resetTime: number;
}

interface ClientIpResolution {
  clientIp: string;
  forwardedChainRejected: boolean;
}

class RateLimiter {
  private store = new Map<string, RateLimitEntry>();
  private readonly maxRequests: number;
  private readonly windowMs: number; // in milliseconds
  private cleanupInterval: NodeJS.Timeout;

  constructor(maxRequests = 100, windowMs = 60 * 60 * 1000) {
    // Default: 100 requests per hour
    this.maxRequests = maxRequests;
    this.windowMs = windowMs;

    // Clean up old entries every 5 minutes
    this.cleanupInterval = setInterval(
      () => {
        const now = Date.now();
        for (const [key, entry] of this.store.entries()) {
          if (entry.resetTime < now) {
            this.store.delete(key);
          }
        }
      },
      5 * 60 * 1000,
    );
  }

  isAllowed(identifier: string): {
    allowed: boolean;
    remaining: number;
    resetTime: number;
  } {
    const now = Date.now();
    let entry = this.store.get(identifier);

    // Initialize or reset if window has passed
    if (!entry || entry.resetTime < now) {
      entry = {
        timestamps: [],
        resetTime: now + this.windowMs,
      };
      this.store.set(identifier, entry);
    }

    // Remove timestamps outside the window
    entry.timestamps = entry.timestamps.filter(
      (ts) => ts > now - this.windowMs,
    );

    // Check if limit exceeded
    if (entry.timestamps.length >= this.maxRequests) {
      return {
        allowed: false,
        remaining: 0,
        resetTime: entry.resetTime,
      };
    }

    // Add current timestamp
    entry.timestamps.push(now);

    return {
      allowed: true,
      remaining: this.maxRequests - entry.timestamps.length,
      resetTime: entry.resetTime,
    };
  }

  destroy() {
    clearInterval(this.cleanupInterval);
    this.store.clear();
  }
}

// Create a singleton instance
// 360 req/hour: accommodates 60s polling from up to ~2 open tabs with 3× headroom.
// Previous limit (100/hr) was exhausted after ~50 min with two tabs, silently
// blocking initial loads on reload (429 had no recovery path on first mount).
export const globalRateLimiter = new RateLimiter(360, 60 * 60 * 1000); // 360 req/hour

function parseTrustedProxyIps(rawValue: string | undefined): Set<string> {
  const trusted = new Set<string>(['127.0.0.1', '::1']);
  (rawValue || '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean)
    .forEach((value) => trusted.add(value));
  return trusted;
}

function makeUnknownClientId(req: Request, reason: string): string {
  const userAgent = (req.headers.get('user-agent') || 'unknown').slice(0, 120);
  return `unknown:${reason}:${userAgent}`;
}

function parseForwardedChain(value: string | null): string[] {
  if (!value) {
    return [];
  }

  return value
    .split(',')
    .map((ip) => ip.trim())
    .filter(Boolean);
}

export function resolveClientIp(req: Request): ClientIpResolution {
  const trustedProxyIps = parseTrustedProxyIps(process.env.TRUSTED_PROXY_IPS);
  const directProxyIp = req.headers.get('x-real-ip')?.trim() || null;
  const forwardedChain = parseForwardedChain(req.headers.get('x-forwarded-for'));

  if (forwardedChain.length > 0) {
    if (!directProxyIp || !trustedProxyIps.has(directProxyIp)) {
      return {
        clientIp: makeUnknownClientId(req, 'untrusted-forwarded-chain'),
        forwardedChainRejected: true,
      };
    }

    return {
      clientIp: forwardedChain[0],
      forwardedChainRejected: false,
    };
  }

  const directHeaderCandidates = [
    directProxyIp,
    req.headers.get('cf-connecting-ip'),
    req.headers.get('x-vercel-forwarded-for'),
    req.headers.get('fly-client-ip'),
    req.headers.get('x-client-ip'),
  ];

  for (const candidate of directHeaderCandidates) {
    if (candidate && candidate.trim()) {
      return {
        clientIp: candidate.trim(),
        forwardedChainRejected: false,
      };
    }
  }

  return {
    clientIp: makeUnknownClientId(req, 'missing-forwarding-context'),
    forwardedChainRejected: false,
  };
}

export function getClientIp(req: Request): string {
  return resolveClientIp(req).clientIp;
}

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  resetTime: number;
  headers: Record<string, string>;
}

export function checkRateLimit(req: Request): RateLimitResult {
  const clientIp = getClientIp(req);
  const result = globalRateLimiter.isAllowed(clientIp);

  return {
    ...result,
    headers: {
      'X-RateLimit-Limit': '360',
      'X-RateLimit-Remaining': result.remaining.toString(),
      'X-RateLimit-Reset': Math.ceil(result.resetTime / 1000).toString(),
    },
  };
}
