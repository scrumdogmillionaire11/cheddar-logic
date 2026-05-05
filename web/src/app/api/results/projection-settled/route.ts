import { NextRequest, NextResponse } from 'next/server.js';
import data from '@cheddar-logic/data';
import { ensureDbReady } from '@/lib/db-init';
import {
  performSecurityChecks,
  addRateLimitHeaders,
} from '@/lib/api-security';
import {
  type ConfidenceTier,
  normalizeToConfidenceTier,
} from '@/lib/types/projection-accuracy';
import {
  PROJECTION_RESULTS_PAGE_FAMILIES,
  PROJECTION_RESULTS_FAMILY_TOKEN_ALIASES,
} from '@/lib/results/projection-results-contract';

const {
  getDatabaseReadOnly,
  closeReadOnlyInstance,
} = data;

// WI-0967: Query projection_proxy_evals table for graded projection results.
// These rows come from settle_projections.js which calls buildProjectionProxyMarketRows().
type DbProxyEvalRow = {
  id: number;
  card_id: string;
  game_id: string;
  game_date: string;
  sport: string;
  card_family: string;
  proj_value: number;
  actual_value: number;
  proxy_line: number;
  edge_vs_line: number;
  recommended_side: 'OVER' | 'UNDER' | 'PASS';
  tier: 'PLAY' | 'SLIGHT_EDGE' | 'LEAN' | 'STRONG' | 'PASS';
  confidence_bucket: string;
  agreement_group: string;
  graded_result: 'WIN' | 'LOSS' | 'NO_BET';
  hit_flag: number;
  tier_score: number;
  consensus_bonus: number;
  win_probability: number | null;
  edge_pp: number | null;
  confidence_score: number | null;
  accuracy_confidence_band: string | null;
  tracking_role: string | null;
  calibration_bucket: string | null;
  brier_score: number | null;
  expected_outcome_label: string | null;
  card_title: string | null;
  home_team: string | null;
  away_team: string | null;
};

type DbF5MoneylineRow = {
  id: number;
  card_id: string;
  game_id: string;
  settled_at: string | null;
  game_time_utc: string | null;
  sport: string;
  result: string | null;
  card_type: string;
  selection: string | null;
  payload_data: string | null;
  accuracy_projection_value: number | null;
  accuracy_edge_pp: number | null;
  accuracy_confidence_score: number | null;
  accuracy_confidence_band: string | null;
  tracking_role: string | null;
  calibration_bucket: string | null;
  brier_score: number | null;
  expected_outcome_label: string | null;
  card_title: string | null;
  home_team: string | null;
  away_team: string | null;
};

export type ProjectionProxyRow = {
  id: number;
  cardId: string;
  gameId: string;
  gameDateUtc: string;
  sport: string;
  cardFamily: string;
  projValue: number | null;
  actualValue: number;
  proxyLine: number | null;
  edgeVsLine: number | null;
  recommendedSide: 'OVER' | 'UNDER' | 'PASS';
  tier: 'PLAY' | 'SLIGHT_EDGE' | 'LEAN' | 'STRONG' | 'PASS';
  confidenceBucket: string;
  agreementGroup: string;
  gradedResult: 'WIN' | 'LOSS' | 'NO_BET';
  hitFlag: number;
  tierScore: number;
  consensusBonus: number;
  cardTitle: string | null;
  homeTeam: string | null;
  awayTeam: string | null;
  confidenceTier: ConfidenceTier;
  winProbability?: number | null;
  edgePp?: number | null;
  confidenceScore?: number | null;
  confidenceBand?: string | null;
  trackingRole?: string | null;
  calibrationBucket?: string | null;
  brierScore?: number | null;
  expectedOutcomeLabel?: string | null;
  predictionSignalMissing?: boolean;
};

export type ProjectionSettledResponse = {
  success: boolean;
  data?: {
    settledRows: ProjectionProxyRow[];
    totalSettled: number;
    actualsReady: boolean;
  };
  error?: string;
};

type ProjectionProxyInternalRow = ProjectionProxyRow & {
  canonicalAnalyticsPresent: boolean;
};

const ACCURACY_LATEST_CTE_SQL = `WITH accuracy_latest AS (
  SELECT
    pae.card_id,
    pae.projection_raw,
    pae.projection_value,
    pae.win_probability,
    pae.edge_pp,
    pae.confidence_score,
    pae.confidence_band,
    pae.tracking_role,
    pae.calibration_bucket,
    pae.brier_score,
    pae.expected_outcome_label,
    ROW_NUMBER() OVER (
      PARTITION BY pae.card_id
      ORDER BY
        datetime(COALESCE(pae.captured_at, '1970-01-01T00:00:00Z')) DESC,
        pae.id DESC
    ) AS rn
  FROM projection_accuracy_evals pae
)`;

const SUPPORTED_CARD_FAMILIES: string[] = Array.from(PROJECTION_RESULTS_PAGE_FAMILIES);

function resolveRequestedFamily(param: string | null): string | null {
  if (!param) return null;
  const token = param.trim().toUpperCase();
  return PROJECTION_RESULTS_FAMILY_TOKEN_ALIASES[token] ?? token;
}

function parsePayload(value: string | null): Record<string, unknown> | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function toNumberOrNull(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function readObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : null;
}

function resolvePayloadF5WinProbability(
  payload: Record<string, unknown> | null,
  selection: 'HOME' | 'AWAY' | null,
): number | null {
  const projection = readObject(payload?.projection);
  const direct = toNumberOrNull(
    projection?.win_probability ??
      payload?.win_probability ??
      readObject(payload?.decision)?.win_prob,
  );
  if (direct !== null) return direct;

  const homeProb = toNumberOrNull(
    projection?.projected_win_prob_home ??
      payload?.projected_win_prob_home,
  );
  if (homeProb === null || !selection) return null;
  return selection === 'HOME' ? homeProb : 1 - homeProb;
}

function resolveExpectedOutcomeLabel(
  winProbability: number | null,
  gradedResult: 'WIN' | 'LOSS' | 'NO_BET',
  actualValue: number,
): string | null {
  if (actualValue === 0.5) return 'PUSH';
  if (winProbability === null) return null;
  if (gradedResult === 'LOSS') {
    if (winProbability >= 0.65) return 'MODEL_ERROR';
    if (winProbability >= 0.56) return 'BAD_VARIANCE';
    return 'EXPECTED_ISH';
  }
  if (gradedResult === 'WIN') {
    return winProbability >= 0.56 ? 'EXPECTED_WIN' : 'POSITIVE_VARIANCE';
  }
  return null;
}

function resolveF5MlSelection(row: DbF5MoneylineRow, payload: Record<string, unknown> | null): 'HOME' | 'AWAY' | null {
  const payloadSelection =
    (payload?.selection as Record<string, unknown> | undefined)?.side ??
    (payload?.market_context as Record<string, unknown> | undefined)?.selection_side ??
    (payload?.canonical_envelope_v2 as Record<string, unknown> | undefined)?.selection_side ??
    (payload?.decision_v2 as Record<string, unknown> | undefined)?.selection_side ??
    null;
  const raw = String(row.selection ?? payloadSelection ?? '').trim().toUpperCase();
  if (raw === 'HOME' || raw === 'H') return 'HOME';
  if (raw === 'AWAY' || raw === 'A') return 'AWAY';
  return null;
}

function resolveTier(payload: Record<string, unknown> | null): 'PLAY' | 'SLIGHT_EDGE' | 'LEAN' | 'STRONG' | 'PASS' {
  const modelSignalTier = String(payload?.model_signal_tier ?? '').toUpperCase();
  if (modelSignalTier === 'PLAY' || modelSignalTier === 'SLIGHT_EDGE' || modelSignalTier === 'PASS') {
    return modelSignalTier as 'PLAY' | 'SLIGHT_EDGE' | 'PASS';
  }
  const decisionV2 = payload?.decision_v2 as Record<string, unknown> | undefined;
  const official = String(decisionV2?.official_status ?? '').toUpperCase();
  if (official === 'PLAY' || official === 'LEAN') return official;
  if (official === 'PASS') return 'PASS';
  const status = String((payload?.status ?? payload?.action ?? '')).toUpperCase();
  if (status === 'FIRE') return 'PLAY';
  if (status === 'WATCH' || status === 'HOLD') return 'SLIGHT_EDGE';
  if (status === 'PLAY' || status === 'LEAN' || status === 'PASS') return status;
  return 'PASS';
}

function gradedResultToken(value: string | null): 'WIN' | 'LOSS' | 'NO_BET' {
  const token = String(value || '').toLowerCase();
  if (token === 'win' || token === 'won') return 'WIN';
  if (token === 'loss' || token === 'lost') return 'LOSS';
  return 'NO_BET';
}

// Mirrors resolveF5MlConfidenceBand from run_mlb_model.js — confidenceScore is 0–100
function resolveF5MlConfidenceBand(confidenceScore: number): 'HIGH' | 'MED' | 'LOW' {
  if (!Number.isFinite(confidenceScore)) return 'LOW';
  if (confidenceScore >= 70) return 'HIGH';
  if (confidenceScore >= 55) return 'MED';
  return 'LOW';
}

// Last-resort band derivation when confidenceScore is unavailable.
// Uses distance of winProbability from 0.5 as a proxy for model conviction.
function resolveF5MlConfidenceBandFromWinProb(winProb: number): 'HIGH' | 'MED' | 'LOW' {
  const dist = Math.abs(winProb - 0.5);
  if (dist >= 0.20) return 'HIGH';
  if (dist >= 0.05) return 'MED';
  return 'LOW';
}

function normalizeToken(value: string | null | undefined): string {
  return String(value ?? '')
    .trim()
    .replace(/\s+/g, ' ')
    .toUpperCase();
}

function toUtcDayKey(value: string | null | undefined): string {
  const raw = String(value ?? '').trim();
  if (!raw) return '';
  const ts = Date.parse(raw);
  if (Number.isFinite(ts)) {
    return new Date(ts).toISOString().slice(0, 10);
  }
  return raw.slice(0, 10);
}

function buildDedupKey(row: ProjectionProxyRow): string {
  const family = normalizeToken(row.cardFamily);
  const sport = normalizeToken(row.sport);

  // F5 moneyline rows can arrive through multiple IDs for the same matchup/date
  // (materialized + fallback pathways). Collapse them to one canonical row.
  if (family === 'MLB_F5_ML') {
    const day = toUtcDayKey(row.gameDateUtc);
    const away = normalizeToken(row.awayTeam);
    const home = normalizeToken(row.homeTeam);
    const side = normalizeToken(row.recommendedSide);
    if (day && away && home) {
      return [sport, family, day, away, home, side].join('|');
    }
  }

  return [
    normalizeToken(row.gameId),
    sport,
    family,
    normalizeToken(row.recommendedSide),
    normalizeToken(row.gradedResult),
    row.projValue ?? 'null',
    row.edgeVsLine ?? 'null',
    normalizeToken(row.confidenceBand),
    normalizeToken(row.homeTeam),
    normalizeToken(row.awayTeam),
  ].join('|');
}

function choosePreferredRow(current: ProjectionProxyInternalRow, candidate: ProjectionProxyInternalRow): ProjectionProxyInternalRow {
  if (candidate.canonicalAnalyticsPresent !== current.canonicalAnalyticsPresent) {
    return candidate.canonicalAnalyticsPresent ? candidate : current;
  }

  const quality = (row: ProjectionProxyRow): number => {
    let score = 0;
    if (row.predictionSignalMissing !== true && row.winProbability !== null && row.winProbability !== undefined) score += 4;
    if (row.projValue !== null && row.projValue !== undefined) score += 3;
    if (row.edgeVsLine !== null && row.edgeVsLine !== undefined) score += 2;
    if (normalizeToken(row.confidenceBand) && normalizeToken(row.confidenceBand) !== 'MISSING_SIGNAL') score += 1;
    return score;
  };

  const currentQuality = quality(current);
  const candidateQuality = quality(candidate);
  if (candidateQuality !== currentQuality) {
    return candidateQuality > currentQuality ? candidate : current;
  }

  const currentTs = Date.parse(current.gameDateUtc);
  const candidateTs = Date.parse(candidate.gameDateUtc);
  if (Number.isFinite(currentTs) && Number.isFinite(candidateTs) && candidateTs !== currentTs) {
    return candidateTs > currentTs ? candidate : current;
  }

  return candidate.id > current.id ? candidate : current;
}

export async function GET(
  request: NextRequest,
): Promise<NextResponse<ProjectionSettledResponse>> {
  const securityCheck = performSecurityChecks(request, '/api/results/projection-settled');
  if (!securityCheck.allowed) {
    return securityCheck.error as NextResponse<ProjectionSettledResponse>;
  }

  const requestedFamily = resolveRequestedFamily(
    request.nextUrl.searchParams.get('family'),
  );
  const queryFamilies =
    requestedFamily !== null && SUPPORTED_CARD_FAMILIES.includes(requestedFamily)
      ? [requestedFamily]
      : SUPPORTED_CARD_FAMILIES;
  const queryFamilySql = queryFamilies.map(() => '?').join(', ');

  let db: ReturnType<typeof getDatabaseReadOnly> | null = null;

  try {
    await ensureDbReady();
    db = getDatabaseReadOnly();

    // WI-0967: Query projection_proxy_evals directly.

    const proxyRows = db
      .prepare(
        `${ACCURACY_LATEST_CTE_SQL},
         ranked_evals AS (
           SELECT ppe.*,
                  ROW_NUMBER() OVER (
                    PARTITION BY ppe.card_family
                    ORDER BY ppe.game_date DESC, ppe.id DESC
                  ) AS family_rank
           FROM projection_proxy_evals ppe
           WHERE ppe.card_family IN (${queryFamilySql})
             AND (ppe.card_family != 'MLB_F5_TOTAL' OR ppe.grading_mode = 'OFFICIAL')
         )
         SELECT
           re.id,
           re.card_id,
           re.game_id,
           re.game_date,
           re.sport,
           re.card_family,
           re.proj_value,
           re.actual_value,
           re.proxy_line,
           re.edge_vs_line,
           re.recommended_side,
           re.tier,
           re.confidence_bucket,
           re.agreement_group,
           re.graded_result,
           re.hit_flag,
           re.tier_score,
           re.consensus_bonus,
           al.projection_value AS win_probability,
           al.edge_pp,
           al.confidence_score,
           al.confidence_band AS accuracy_confidence_band,
           al.tracking_role,
           al.calibration_bucket,
           al.brier_score,
           al.expected_outcome_label,
           cp.card_title,
           g.home_team,
           g.away_team
         FROM ranked_evals re
         LEFT JOIN card_payloads cp ON cp.id = re.card_id
         LEFT JOIN accuracy_latest al ON al.card_id = re.card_id AND al.rn = 1
         LEFT JOIN games g ON g.game_id = re.game_id
         WHERE re.family_rank <= 100
         ORDER BY re.game_date DESC, re.id DESC`,
      )
      .all(...queryFamilies) as DbProxyEvalRow[];

    const enrichedRows: ProjectionProxyInternalRow[] = proxyRows.map((row) => {
      return {
        id: row.id,
        cardId: row.card_id,
        gameId: row.game_id,
        gameDateUtc: row.game_date,
        sport: row.sport,
        cardFamily: row.card_family,
        projValue: row.proj_value,
        actualValue: row.actual_value,
        proxyLine: row.proxy_line,
        edgeVsLine: row.edge_vs_line,
        recommendedSide: row.recommended_side,
        tier: row.tier,
        confidenceBucket: row.confidence_bucket,
        agreementGroup: row.agreement_group,
        gradedResult: row.graded_result,
        hitFlag: row.hit_flag,
        tierScore: row.tier_score,
        consensusBonus: row.consensus_bonus,
        cardTitle: row.card_title,
        homeTeam: row.home_team,
        awayTeam: row.away_team,
        confidenceTier: normalizeToConfidenceTier(
          row.accuracy_confidence_band ?? row.confidence_bucket,
          row.confidence_score,
          row.win_probability,
        ),
        winProbability: row.win_probability,
        edgePp: row.edge_pp,
        confidenceScore: row.confidence_score,
        confidenceBand: row.accuracy_confidence_band ?? row.confidence_bucket,
        trackingRole: row.tracking_role,
        calibrationBucket: row.calibration_bucket,
        brierScore: row.brier_score,
        expectedOutcomeLabel: row.expected_outcome_label,
        predictionSignalMissing:
          String(row.card_family || '').toUpperCase() === 'MLB_F5_ML' &&
          row.win_probability === null,
        canonicalAnalyticsPresent:
          row.win_probability !== null ||
          row.edge_pp !== null ||
          row.confidence_score !== null ||
          row.accuracy_confidence_band !== null ||
          row.tracking_role !== null ||
          row.calibration_bucket !== null ||
          row.brier_score !== null ||
          row.expected_outcome_label !== null,
      };
    });
    const materializedF5MoneylineCardIds = new Set(
      enrichedRows
        .filter((row) => String(row.cardFamily || '').toUpperCase() === 'MLB_F5_ML')
        .map((row) => row.cardId),
    );

    const f5MoneylineRows: DbF5MoneylineRow[] = queryFamilies.includes('MLB_F5_ML')
      ? (db
          .prepare(
            `${ACCURACY_LATEST_CTE_SQL}
         SELECT
           cr.id,
           cr.card_id,
           cr.game_id,
           cr.settled_at,
           g.game_time_utc,
           cr.sport,
           cr.result,
           cr.card_type,
           cr.selection,
           cp.payload_data,
           al.projection_value AS accuracy_projection_value,
           al.edge_pp AS accuracy_edge_pp,
           al.confidence_score AS accuracy_confidence_score,
           al.confidence_band AS accuracy_confidence_band,
           al.tracking_role,
           al.calibration_bucket,
           al.brier_score,
           al.expected_outcome_label,
           cp.card_title,
           g.home_team,
           g.away_team
         FROM card_results cr
         JOIN card_payloads cp ON cp.id = cr.card_id
         LEFT JOIN accuracy_latest al ON al.card_id = cr.card_id AND al.rn = 1
         LEFT JOIN games g ON g.game_id = cr.game_id
         WHERE LOWER(cr.card_type) = 'mlb-f5-ml'
           AND LOWER(cr.status) = 'settled'
         ORDER BY COALESCE(cr.settled_at, g.game_time_utc) DESC, cr.id DESC
         LIMIT 200`,
          )
          .all() as DbF5MoneylineRow[])
      : [];

    const mappedF5MoneylineRows: ProjectionProxyInternalRow[] = f5MoneylineRows.map((row) => {
      const payload = parsePayload(row.payload_data);
      const selection = resolveF5MlSelection(row, payload);
      const payloadProb =
        row.accuracy_projection_value === null
          ? resolvePayloadF5WinProbability(payload, selection)
          : null;
      const projProb = row.accuracy_projection_value ?? payloadProb;
      const projValue = projProb;
      const resultToken = gradedResultToken(row.result);
      const actualValue =
        resultToken === 'WIN' ? 1 : resultToken === 'LOSS' ? 0 : 0.5;
      const recommendedSide: 'OVER' | 'UNDER' | 'PASS' =
        selection === 'HOME' ? 'OVER' : selection === 'AWAY' ? 'UNDER' : 'PASS';
      const payloadEdge =
        row.accuracy_edge_pp === null ? toNumberOrNull(payload?.edge_pp) : null;
      const edgeVsLine = row.accuracy_edge_pp ?? payloadEdge ?? (projValue === null ? null : projValue - 0.5);
      const confidenceScore =
        row.accuracy_confidence_score ??
        (row.accuracy_confidence_score === null ? toNumberOrNull(payload?.confidence_score) : null);
      const payloadDriver0 =
        row.accuracy_confidence_score === null || row.accuracy_confidence_band === null
          ? Array.isArray(payload?.drivers)
            ? readObject((payload!.drivers as unknown[])[0])
            : null
          : null;
      const payloadConfidenceBand =
        row.accuracy_confidence_band === null
          ? String(payload?.confidence_band ?? '').trim() ||
            String(payloadDriver0?.confidence_band ?? '').trim()
          : '';
      const resolvedConfidenceScore =
        confidenceScore ??
        (row.accuracy_confidence_score === null
          ? toNumberOrNull(payloadDriver0?.confidence_score)
          : null);
      const confidenceBand =
        row.accuracy_confidence_band ??
        (payloadConfidenceBand ? payloadConfidenceBand : null) ??
        (resolvedConfidenceScore !== null ? resolveF5MlConfidenceBand(resolvedConfidenceScore) : null) ??
        (projValue !== null ? resolveF5MlConfidenceBandFromWinProb(projValue) : null);
      const trackingRole =
        row.tracking_role ?? String(payload?.tracking_role ?? 'CALIBRATION_ONLY');
      const expectedOutcomeLabel =
        row.expected_outcome_label ??
        resolveExpectedOutcomeLabel(projValue, resultToken, actualValue);

      return {
        id: -1 * row.id,
        cardId: row.card_id,
        gameId: row.game_id,
        gameDateUtc: row.game_time_utc || row.settled_at || new Date(0).toISOString(),
        sport: row.sport || 'MLB',
        cardFamily: 'MLB_F5_ML',
        projValue,
        actualValue,
        proxyLine: projValue === null ? null : 0.5,
        edgeVsLine,
        recommendedSide,
        tier: resolveTier(payload),
        confidenceBucket: confidenceBand ?? 'MISSING_SIGNAL',
        agreementGroup: 'DIRECT_SELECTION',
        gradedResult: resultToken,
        hitFlag: resultToken === 'WIN' ? 1 : 0,
        tierScore: 0,
        consensusBonus: 0,
        cardTitle: row.card_title,
        homeTeam: row.home_team,
        awayTeam: row.away_team,
        confidenceTier: normalizeToConfidenceTier(
          confidenceBand,
          resolvedConfidenceScore,
          projValue,
        ),
        winProbability: projValue,
        edgePp: edgeVsLine,
        confidenceScore: resolvedConfidenceScore,
        confidenceBand,
        trackingRole,
        calibrationBucket: row.calibration_bucket,
        brierScore: row.brier_score,
        expectedOutcomeLabel,
        predictionSignalMissing: projValue === null,
        canonicalAnalyticsPresent:
          row.accuracy_projection_value !== null ||
          row.accuracy_edge_pp !== null ||
          row.accuracy_confidence_score !== null ||
          row.accuracy_confidence_band !== null ||
          row.tracking_role !== null ||
          row.calibration_bucket !== null ||
          row.brier_score !== null ||
          row.expected_outcome_label !== null,
      };
    }).filter((row) => !materializedF5MoneylineCardIds.has(row.cardId));

    const settledRows = [...enrichedRows, ...mappedF5MoneylineRows].sort((a, b) => {
      const dateDiff = Date.parse(b.gameDateUtc) - Date.parse(a.gameDateUtc);
      if (Number.isFinite(dateDiff) && dateDiff !== 0) return dateDiff;
      return b.id - a.id;
    });

    const dedupedByKey = new Map<string, ProjectionProxyInternalRow>();
    for (const row of settledRows) {
      const key = buildDedupKey(row);
      const existing = dedupedByKey.get(key);
      if (!existing) {
        dedupedByKey.set(key, row);
        continue;
      }
      dedupedByKey.set(key, choosePreferredRow(existing, row));
    }

    const settledRowsDeduped = Array.from(dedupedByKey.values()).sort((a, b) => {
      const dateDiff = Date.parse(b.gameDateUtc) - Date.parse(a.gameDateUtc);
      if (Number.isFinite(dateDiff) && dateDiff !== 0) return dateDiff;
      return b.id - a.id;
    }).map(({ canonicalAnalyticsPresent, ...row }) => {
      void canonicalAnalyticsPresent;
      return row;
    });

    const response = NextResponse.json({
      success: true,
      data: {
        settledRows: settledRowsDeduped,
        totalSettled: settledRowsDeduped.length,
        actualsReady: true,
      },
    });
    return addRateLimitHeaders(
      response as NextResponse<ProjectionSettledResponse>,
      request,
    ) as NextResponse<ProjectionSettledResponse>;
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'Unknown error';
    console.error('[API] projection-settled error:', message);
    const errorResponse = NextResponse.json(
      { success: false, error: message },
      { status: 500 },
    );
    return addRateLimitHeaders(
      errorResponse as NextResponse<ProjectionSettledResponse>,
      request,
    ) as NextResponse<ProjectionSettledResponse>;
  } finally {
    if (db) {
      closeReadOnlyInstance(db);
    }
  }
}
