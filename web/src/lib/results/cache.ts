import type { ResultsRequestFilters } from './query-layer';

type CachedEntry = {
  body: unknown;
  coverageHeader: string;
  expiresAt: number;
};

const resultsCache = new Map<string, CachedEntry>();
const CACHE_TTL_MS = 15_000;
const CACHE_MAX = 100;

function evictExpiredResultsCacheEntries(): void {
  const now = Date.now();
  for (const [key, value] of resultsCache) {
    if (value.expiresAt <= now) resultsCache.delete(key);
  }
}

export function buildResultsCacheKey(filters: ResultsRequestFilters): string {
  return [
    filters.sport,
    filters.cardCategory,
    filters.minConfidence,
    filters.market,
    filters.dedupe,
    filters.limit,
  ].join('|');
}

export function getResultsCacheEntry(key: string): CachedEntry | null {
  evictExpiredResultsCacheEntries();
  const cached = resultsCache.get(key);
  if (!cached || cached.expiresAt <= Date.now()) return null;
  return cached;
}

export function setResultsCacheEntry(
  key: string,
  body: unknown,
  coverageHeader: string,
): void {
  if (resultsCache.size >= CACHE_MAX) {
    const oldest = resultsCache.keys().next().value;
    if (oldest !== undefined) resultsCache.delete(oldest);
  }

  resultsCache.set(key, {
    body,
    coverageHeader,
    expiresAt: Date.now() + CACHE_TTL_MS,
  });
}
