import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';

interface RateLimitBucket {
  timestamps: number[];
  resetTime: number;
}

interface RateLimitStateFile {
  version: 1;
  buckets: Record<string, RateLimitBucket>;
}

interface ClientIpResolution {
  clientIp: string;
  forwardedChainRejected: boolean;
}

export interface RateLimitDecision {
  allowed: boolean;
  remaining: number;
  resetTime: number;
  retryAfterSeconds: number;
}

export interface RateLimitBackend {
  hit(
    identifier: string,
    now: number,
    maxRequests: number,
    windowMs: number,
  ): RateLimitDecision;
  clear(): void;
  destroy?(): void;
}

export interface FileRateLimitBackendOptions {
  lockWaitMs?: number;
  lockStaleMs?: number;
}

export interface RateLimiterOptions {
  backend?: RateLimitBackend;
  stateFilePath?: string;
  now?: () => number;
  lockWaitMs?: number;
  lockStaleMs?: number;
}

function readPositiveIntegerEnv(name: string, defaultValue: number): number {
  const rawValue = process.env[name];
  if (!rawValue) {
    return defaultValue;
  }

  const parsed = Number.parseInt(rawValue, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : defaultValue;
}

const RATE_LIMIT_DEFAULTS = {
  maxRequests: readPositiveIntegerEnv('RATE_LIMIT_MAX_REQUESTS', 360),
  windowMs: readPositiveIntegerEnv('RATE_LIMIT_WINDOW_MS', 60 * 60 * 1000),
  stateFilePath: process.env.RATE_LIMIT_STATE_FILE,
  lockWaitMs: readPositiveIntegerEnv('RATE_LIMIT_LOCK_WAIT_MS', 250),
  lockStaleMs: readPositiveIntegerEnv('RATE_LIMIT_LOCK_STALE_MS', 5000),
};

function createEmptyState(): RateLimitStateFile {
  return {
    version: 1,
    buckets: {},
  };
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}

function sleepSync(ms: number): void {
  const view = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(view, 0, 0, ms);
}

function computeRetryAfterSeconds(resetTime: number, now: number): number {
  return Math.max(1, Math.ceil((resetTime - now) / 1000));
}

function applySlidingWindowHit(
  state: RateLimitStateFile,
  identifier: string,
  now: number,
  maxRequests: number,
  windowMs: number,
): RateLimitDecision {
  let entry = state.buckets[identifier];

  if (!entry || entry.resetTime < now) {
    entry = {
      timestamps: [],
      resetTime: now + windowMs,
    };
    state.buckets[identifier] = entry;
  }

  entry.timestamps = entry.timestamps.filter((ts) => ts > now - windowMs);

  for (const [key, bucket] of Object.entries(state.buckets)) {
    if (bucket.resetTime < now) {
      delete state.buckets[key];
    }
  }

  if (entry.timestamps.length >= maxRequests) {
    return {
      allowed: false,
      remaining: 0,
      resetTime: entry.resetTime,
      retryAfterSeconds: computeRetryAfterSeconds(entry.resetTime, now),
    };
  }

  entry.timestamps.push(now);

  return {
    allowed: true,
    remaining: maxRequests - entry.timestamps.length,
    resetTime: entry.resetTime,
    retryAfterSeconds: 0,
  };
}

function defaultStateFilePath(): string {
  return join(tmpdir(), 'cheddar-logic', 'rate-limiter-state.json');
}

export class FileRateLimitBackend implements RateLimitBackend {
  private readonly stateFilePath: string;
  private readonly lockFilePath: string;
  private readonly lockWaitMs: number;
  private readonly lockStaleMs: number;

  constructor(
    stateFilePath = defaultStateFilePath(),
    options: FileRateLimitBackendOptions = {},
  ) {
    this.stateFilePath = stateFilePath;
    this.lockFilePath = `${stateFilePath}.lock`;
    this.lockWaitMs = options.lockWaitMs ?? RATE_LIMIT_DEFAULTS.lockWaitMs;
    this.lockStaleMs = options.lockStaleMs ?? RATE_LIMIT_DEFAULTS.lockStaleMs;
    mkdirSync(dirname(this.stateFilePath), { recursive: true });
  }

  hit(
    identifier: string,
    now: number,
    maxRequests: number,
    windowMs: number,
  ): RateLimitDecision {
    return this.withLock(() => {
      const state = this.readState();
      const result = applySlidingWindowHit(
        state,
        identifier,
        now,
        maxRequests,
        windowMs,
      );
      this.writeState(state);
      return result;
    });
  }

  clear(): void {
    this.withLock(() => {
      this.writeState(createEmptyState());
    });
  }

  private withLock<T>(callback: () => T): T {
    const lockFd = this.acquireLock();
    try {
      return callback();
    } finally {
      closeSync(lockFd);
      rmSync(this.lockFilePath, { force: true });
    }
  }

  private acquireLock(): number {
    const startedAt = Date.now();

    while (true) {
      try {
        return openSync(this.lockFilePath, 'wx');
      } catch (error) {
        if (!isNodeError(error) || error.code !== 'EEXIST') {
          throw error;
        }

        this.removeStaleLock();

        if (Date.now() - startedAt >= this.lockWaitMs) {
          throw new Error(
            `Timed out waiting for rate-limit state lock ${this.lockFilePath}`,
          );
        }

        sleepSync(10);
      }
    }
  }

  private removeStaleLock(): void {
    try {
      const stats = statSync(this.lockFilePath);
      if (Date.now() - stats.mtimeMs > this.lockStaleMs) {
        rmSync(this.lockFilePath, { force: true });
      }
    } catch (error) {
      if (!isNodeError(error) || error.code !== 'ENOENT') {
        throw error;
      }
    }
  }

  private readState(): RateLimitStateFile {
    try {
      const parsed = JSON.parse(
        readFileSync(this.stateFilePath, 'utf8'),
      ) as Partial<RateLimitStateFile>;
      if (
        parsed.version === 1 &&
        parsed.buckets &&
        typeof parsed.buckets === 'object'
      ) {
        return {
          version: 1,
          buckets: parsed.buckets as Record<string, RateLimitBucket>,
        };
      }
    } catch (error) {
      if (!isNodeError(error) || error.code !== 'ENOENT') {
        return createEmptyState();
      }
    }

    return createEmptyState();
  }

  private writeState(state: RateLimitStateFile): void {
    const tempPath = `${this.stateFilePath}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(tempPath, JSON.stringify(state), 'utf8');
    renameSync(tempPath, this.stateFilePath);
  }
}

class MemoryRateLimitBackend implements RateLimitBackend {
  private readonly state = createEmptyState();

  hit(
    identifier: string,
    now: number,
    maxRequests: number,
    windowMs: number,
  ): RateLimitDecision {
    return applySlidingWindowHit(
      this.state,
      identifier,
      now,
      maxRequests,
      windowMs,
    );
  }

  clear(): void {
    this.state.buckets = {};
  }
}

export class RateLimiter {
  private readonly maxRequests: number;
  private readonly windowMs: number; // in milliseconds
  private readonly backend: RateLimitBackend;
  private readonly now: () => number;

  constructor(
    maxRequests = RATE_LIMIT_DEFAULTS.maxRequests,
    windowMs = RATE_LIMIT_DEFAULTS.windowMs,
    options: RateLimiterOptions = {},
  ) {
    this.maxRequests = maxRequests;
    this.windowMs = windowMs;
    this.now = options.now ?? Date.now;
    this.backend =
      options.backend ??
      new FileRateLimitBackend(
        options.stateFilePath ?? RATE_LIMIT_DEFAULTS.stateFilePath,
        {
          lockWaitMs: options.lockWaitMs,
          lockStaleMs: options.lockStaleMs,
        },
      );
  }

  static createInMemoryForTest(
    maxRequests = RATE_LIMIT_DEFAULTS.maxRequests,
    windowMs = RATE_LIMIT_DEFAULTS.windowMs,
    now: () => number = Date.now,
  ): RateLimiter {
    return new RateLimiter(maxRequests, windowMs, {
      backend: new MemoryRateLimitBackend(),
      now,
    });
  }

  isAllowed(identifier: string): RateLimitDecision {
    return this.backend.hit(
      identifier,
      this.now(),
      this.maxRequests,
      this.windowMs,
    );
  }

  destroy() {
    this.backend.clear();
    this.backend.destroy?.();
  }
}

// Create a singleton instance
// 360 req/hour: accommodates 60s polling from up to ~2 open tabs with 3× headroom.
// Previous limit (100/hr) was exhausted after ~50 min with two tabs, silently
// blocking initial loads on reload (429 had no recovery path on first mount).
export const globalRateLimiter = new RateLimiter(
  RATE_LIMIT_DEFAULTS.maxRequests,
  RATE_LIMIT_DEFAULTS.windowMs,
);

function parseTrustedProxyIps(rawValue: string | undefined): Set<string> {
  const trusted = new Set<string>(['127.0.0.1', '::1']);
  (rawValue || '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean)
    .forEach((value) => trusted.add(value));
  return trusted;
}

function hashRateLimitIdentity(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 24);
}

function readStableHeader(req: Request, name: string): string {
  return (req.headers.get(name) || 'unknown').slice(0, 160);
}

function makeUnknownClientId(req: Request, reason: string): string {
  const requestHost = (() => {
    try {
      return new URL(req.url).host;
    } catch {
      return 'unknown-host';
    }
  })();
  const fingerprintHeaders = [
    'user-agent',
    'accept-language',
    'accept',
    'accept-encoding',
    'sec-ch-ua',
    'sec-ch-ua-mobile',
    'sec-ch-ua-platform',
    'cf-ipcountry',
    'x-vercel-ip-country',
    'x-vercel-ip-region',
    'x-vercel-ip-city',
  ];
  const fingerprint = [
    `reason=${reason}`,
    `host=${requestHost}`,
    ...fingerprintHeaders.map(
      (headerName) => `${headerName}=${readStableHeader(req, headerName)}`,
    ),
  ].join('\n');

  return `unknown:${reason}:${hashRateLimitIdentity(fingerprint)}`;
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
  retryAfterSeconds: number;
  headers: Record<string, string>;
}

export function checkRateLimit(req: Request): RateLimitResult {
  const clientIp = getClientIp(req);
  const result = globalRateLimiter.isAllowed(clientIp);

  return {
    ...result,
    headers: {
      'X-RateLimit-Limit': RATE_LIMIT_DEFAULTS.maxRequests.toString(),
      'X-RateLimit-Remaining': result.remaining.toString(),
      'X-RateLimit-Reset': Math.ceil(result.resetTime / 1000).toString(),
    },
  };
}
