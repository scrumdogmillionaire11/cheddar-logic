import { NextRequest, NextResponse } from 'next/server';
import { getDatabaseReadOnly, closeReadOnlyInstance } from '@cheddar-logic/data';
import { ensureDbReady } from '@/lib/db-init';
import {
  buildResultsCacheKey,
  getResultsCacheEntry,
  setResultsCacheEntry,
} from '@/lib/results/cache';
import {
  hasResultsReportingTables,
  parseResultsRequestFilters,
  queryLedgerRowsForIds,
  queryResultsReportingData,
} from '@/lib/results/query-layer';
import {
  buildEmptyResultsResponseBody,
  buildResultsAggregation,
  buildResultsResponseBody,
  buildSettlementCoverageHeader,
} from '@/lib/results/transform-layer';
import {
  PROJECTION_TRACKING_CARD_TYPES,
} from './projection-metrics';
import {
  performSecurityChecks,
  createCorrelationId,
  finalizeApiResponse,
  createOpaqueErrorResponse,
} from '../../../lib/api-security';


function jsonResponse(body: unknown): NextResponse {
  return NextResponse.json(body, {
    headers: { 'Content-Type': 'application/json' },
  });
}

function withSettlementCoverage(
  response: NextResponse,
  coverageHeader: string,
): NextResponse {
  response.headers.set('X-Settlement-Coverage', coverageHeader);
  return response;
}

export async function GET(request: NextRequest) {
  // Without Odds Mode: settlement is disabled, so there are no results to show.
  if (process.env.ENABLE_WITHOUT_ODDS_MODE === 'true') {
    const response = NextResponse.json(
      {
        success: true,
        withoutOddsMode: true,
        data: null,
      },
      { status: 200 },
    );
    return finalizeApiResponse(response, request);
  }

  let db: ReturnType<typeof getDatabaseReadOnly> | null = null;
  try {
    const securityCheck = performSecurityChecks(request, '/api/results');
    if (!securityCheck.allowed) {
      return securityCheck.error!;
    }

    await ensureDbReady();
    db = getDatabaseReadOnly();

    if (!hasResultsReportingTables(db)) {
      const response = withSettlementCoverage(
        jsonResponse(buildEmptyResultsResponseBody()),
        '0/0',
      );
      return finalizeApiResponse(response, request);
    }

    const filters = parseResultsRequestFilters(request.nextUrl.searchParams);
    const cacheKey = buildResultsCacheKey(filters);
    if (!filters.diagnosticsEnabled) {
      const cached = getResultsCacheEntry(cacheKey);
      if (cached) {
        const response = withSettlementCoverage(
          jsonResponse(cached.body),
          cached.coverageHeader,
        );
        return finalizeApiResponse(response, request);
      }
    }

    const queryData = queryResultsReportingData(
      db,
      filters,
      PROJECTION_TRACKING_CARD_TYPES,
    );
    const coverageHeader = buildSettlementCoverageHeader(queryData.meta);

    if (queryData.dedupedIds.length === 0) {
      const responseBody = buildEmptyResultsResponseBody(
        filters,
        queryData.meta,
      );
      const response = withSettlementCoverage(
        jsonResponse(responseBody),
        coverageHeader,
      );
      return finalizeApiResponse(response, request);
    }

    const aggregation = buildResultsAggregation(
      queryData.actionableRows,
      queryData.projectionTrackingRows,
    );
    const ledgerRows = filters.includeLedger
      ? queryLedgerRowsForIds(
          db,
          aggregation.oddsBackedLedgerIds,
          queryData.schema,
          filters.limit,
        )
      : [];
    const responseBody = buildResultsResponseBody(
      aggregation,
      ledgerRows,
      filters,
      queryData.meta,
    );

    if (!filters.diagnosticsEnabled) {
      setResultsCacheEntry(cacheKey, responseBody, coverageHeader);
    }

    const response = withSettlementCoverage(
      jsonResponse(responseBody),
      coverageHeader,
    );
    return finalizeApiResponse(response, request);
  } catch (error) {
    const correlationId = createCorrelationId();
    console.error('[API] Error fetching results:', { correlationId, error });
    return createOpaqueErrorResponse(request, 500, 'Internal server error');
  } finally {
    if (db) {
      closeReadOnlyInstance(db);
    }
  }
}
