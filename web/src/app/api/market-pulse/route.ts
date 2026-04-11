/**
 * GET /api/market-pulse
 *
 * Returns market line and odds discrepancies for the Market Pulse dashboard.
 * Server-side in-memory cache with 4.5-minute TTL prevents per-request DB reads.
 *
 * Query params:
 *   sport        - optional; one of NBA, MLB, NHL (default: ALL)
 *   includeWatch - optional; set to "true" to include WATCH-tier items
 *                  (default: TRIGGER-tier only)
 *
 * Response shape:
 * {
 *   scannedAt:  string,       // ISO timestamp of the scan
 *   lineGaps:   LineGap[],    // sorted by delta desc
 *   oddsGaps:   OddsGap[],    // sorted by impliedEdgePct desc
 *   meta: {
 *     gamesScanned:  number,  // unique game_ids in the snapshot window
 *     booksScanned:  number,  // unique books seen across all snapshots
 *     lineGapCount:  number,  // total TRIGGER+WATCH before client filter
 *     oddsGapCount:  number,  // total TRIGGER+WATCH before client filter
 *   }
 * }
 */

// ---------------------------------------------------------------------------
// Domain types (declared first so require() casts below can reference them)
// ---------------------------------------------------------------------------

interface OddsSnapshot {
  game_id: string;
  sport: string;
  captured_at: string;
  raw_data: string;
}

interface LineGap {
  gameId: string;
  sport: string;
  market: string;
  outlierBook: string;
  delta: number;
  tier: 'TRIGGER' | 'WATCH';
  [key: string]: unknown;
}

interface OddsGap {
  gameId: string;
  sport: string;
  market: string;
  outlierBook: string;
  impliedEdgePct: number;
  tier: 'TRIGGER' | 'WATCH';
  [key: string]: unknown;
}

interface MarketPulseResponse {
  scannedAt: string;
  lineGaps: LineGap[];
  oddsGaps: OddsGap[];
  meta: {
    gamesScanned: number;
    booksScanned: number;
    lineGapCount: number;
    oddsGapCount: number;
  };
}

interface CacheEntry {
  payload: MarketPulseResponse;
  expiresAt: number;
}

// ---------------------------------------------------------------------------
// CJS runtime imports (no TS declarations -- require with explicit type casts)
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { getOddsSnapshots } = require('@cheddar-logic/data') as {
  getOddsSnapshots: (sport: string, sinceUtc: string) => OddsSnapshot[];
};

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { scanLineDiscrepancies, scanOddsDiscrepancies } = require(
  '@cheddar-logic/models/src/mispricing-scanner.js',
) as {
  scanLineDiscrepancies: (
    snapshots: OddsSnapshot[],
    config?: Record<string, unknown>,
  ) => LineGap[];
  scanOddsDiscrepancies: (
    snapshots: OddsSnapshot[],
    config?: Record<string, unknown>,
  ) => OddsGap[];
};

// ---------------------------------------------------------------------------
// Module-level server-side cache (survives across requests in the same process)
// ---------------------------------------------------------------------------

const CACHE_TTL_MS = 4.5 * 60 * 1000; // 4 minutes 30 seconds
const LOOKBACK_MS  = 30 * 60 * 1000;  // 30-minute snapshot window

const VALID_SPORTS = ['ALL', 'NBA', 'MLB', 'NHL'] as const;
type ValidSport = (typeof VALID_SPORTS)[number];

// Keyed by sport string ('ALL' | 'NBA' | 'MLB' | 'NHL').
// includeWatch is NOT part of the cache key -- the full TRIGGER+WATCH set is
// cached; filtering to TRIGGER-only happens at serve time.
const cache = new Map<string, CacheEntry>();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Parse raw_data from every snapshot and collect all book names found.
 * Handles both flat { spreads, totals, h2h } and wrapped { markets: { ... } }
 * snapshot shapes written by the odds-ingest pipeline.
 */
function extractUniqueBooks(snapshots: OddsSnapshot[]): Set<string> {
  const books = new Set<string>();
  for (const snapshot of snapshots) {
    try {
      const raw = JSON.parse(snapshot.raw_data ?? '{}') as Record<
        string,
        unknown
      >;
      // Unwrap the markets wrapper when present
      const markets =
        raw.markets && typeof raw.markets === 'object'
          ? (raw.markets as Record<string, unknown>)
          : raw;
      const entries = [
        ...((markets.spreads ?? []) as Array<{ book?: string }>),
        ...((markets.totals  ?? []) as Array<{ book?: string }>),
        ...((markets.h2h     ?? []) as Array<{ book?: string }>),
      ];
      for (const entry of entries) {
        if (entry.book && typeof entry.book === 'string') {
          books.add(entry.book);
        }
      }
    } catch {
      // Malformed raw_data -- silently skip this snapshot
    }
  }
  return books;
}

/**
 * Return a JSON response, filtering gaps to TRIGGER-tier only when
 * includeWatch is false.
 */
function serveResponse(
  payload: MarketPulseResponse,
  includeWatch: boolean,
): Response {
  if (includeWatch) {
    return Response.json(payload);
  }
  return Response.json({
    ...payload,
    lineGaps: payload.lineGaps.filter((g) => g.tier === 'TRIGGER'),
    oddsGaps: payload.oddsGaps.filter((g) => g.tier === 'TRIGGER'),
  });
}

/**
 * Fetch odds snapshots from the DB for the given sport and time window.
 * For 'ALL', concatenates NBA + MLB + NHL results.
 */
function loadSnapshots(sport: ValidSport, sinceUtc: string): OddsSnapshot[] {
  if (sport === 'ALL') {
    return [
      ...getOddsSnapshots('NBA', sinceUtc),
      ...getOddsSnapshots('MLB', sinceUtc),
      ...getOddsSnapshots('NHL', sinceUtc),
    ];
  }
  return getOddsSnapshots(sport, sinceUtc);
}

// ---------------------------------------------------------------------------
// Route handler
// ---------------------------------------------------------------------------

export async function GET(request: Request): Promise<Response> {
  try {
    const { searchParams } = new URL(request.url);
    const rawSport     = searchParams.get('sport')?.toUpperCase() ?? 'ALL';
    const includeWatch = searchParams.get('includeWatch') === 'true';

    // Validate sport param
    if (!VALID_SPORTS.includes(rawSport as ValidSport)) {
      return Response.json({ error: 'Invalid sport' }, { status: 400 });
    }
    const sport = rawSport as ValidSport;

    // Serve from cache when the entry is still fresh
    const cached = cache.get(sport);
    if (cached && cached.expiresAt > Date.now()) {
      return serveResponse(cached.payload, includeWatch);
    }

    // Load snapshots for the 30-minute lookback window (SELECT only, no writes)
    const sinceUtc  = new Date(Date.now() - LOOKBACK_MS).toISOString();
    const snapshots = loadSnapshots(sport, sinceUtc);

    // First pass -- scan for line discrepancies across all snapshots
    const allLineGaps: LineGap[] = scanLineDiscrepancies(snapshots);
    allLineGaps.sort((a, b) => (b.delta ?? 0) - (a.delta ?? 0));

    // Collect game IDs that have at least one line gap
    const lineGapGameIds = new Set(allLineGaps.map((g) => g.gameId));

    // Second pass -- scan for odds discrepancies only on clean games
    // (games with no line gap are considered a clean market reference)
    const cleanSnapshots = snapshots.filter(
      (s) => !lineGapGameIds.has(s.game_id),
    );
    const allOddsGaps: OddsGap[] = scanOddsDiscrepancies(cleanSnapshots);
    allOddsGaps.sort(
      (a, b) => (b.impliedEdgePct ?? 0) - (a.impliedEdgePct ?? 0),
    );

    // Collect metadata
    const uniqueGameIds = new Set(snapshots.map((s) => s.game_id));
    const uniqueBooks   = extractUniqueBooks(snapshots);

    const payload: MarketPulseResponse = {
      scannedAt: new Date().toISOString(),
      lineGaps:  allLineGaps,
      oddsGaps:  allOddsGaps,
      meta: {
        gamesScanned: uniqueGameIds.size,
        booksScanned: uniqueBooks.size,
        lineGapCount: allLineGaps.length,
        oddsGapCount: allOddsGaps.length,
      },
    };

    cache.set(sport, { payload, expiresAt: Date.now() + CACHE_TTL_MS });
    return serveResponse(payload, includeWatch);
  } catch (error) {
    console.error('[API] market-pulse error:', error);
    const message = error instanceof Error ? error.message : 'Unknown error';
    return Response.json({ error: message }, { status: 500 });
  }
}
