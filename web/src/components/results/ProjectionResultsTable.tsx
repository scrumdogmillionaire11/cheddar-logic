'use client';

import { useState } from 'react';
import type { ProjectionProxyRow } from '@/app/api/results/projection-settled/route';
import type { ConfidenceTier, ProjectionAccuracyRecord } from '@/lib/types/projection-accuracy';

// ── helpers ──────────────────────────────────────────────────────────────────

function fmtDate(value: string | null | undefined): string {
  if (!value) return '--';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '--';
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function fmtNum(
  value: number | null | undefined,
  digits = 2,
): string {
  if (value === null || value === undefined || Number.isNaN(value)) return '—';
  return value.toFixed(digits);
}

function fmtPct(
  value: number | null | undefined,
  digits = 1,
  { signed = false } = {},
): string {
  if (value === null || value === undefined || Number.isNaN(value)) return '—';
  const pct = value * 100;
  const sign = signed && pct > 0 ? '+' : '';
  return `${sign}${pct.toFixed(digits)}%`;
}

function fmtMatchup(
  row: ProjectionProxyRow,
): string {
  if (row.homeTeam && row.awayTeam) {
    return `${row.awayTeam} @ ${row.homeTeam}`;
  }
  return row.cardTitle || row.gameId;
}

function directionBadgeClass(side: 'OVER' | 'UNDER' | 'PASS' | null): string {
  if (side === 'OVER')
    return 'border-orange-500/40 bg-orange-500/15 text-orange-200';
  if (side === 'UNDER')
    return 'border-cyan-500/40 bg-cyan-500/15 text-cyan-200';
  return 'border-white/20 bg-white/5 text-cloud/50';
}

function isMoneylineFamily(cardFamily: string | null | undefined): boolean {
  const family = String(cardFamily || '').toUpperCase();
  return family === 'MLB_F5_ML' || family === 'MLB_F5_MONEYLINE';
}

function moneylineProjectedSide(
  row: ProjectionProxyRow,
): 'HOME' | 'AWAY' | 'PASS' {
  if (row.recommendedSide === 'OVER') return 'HOME';
  if (row.recommendedSide === 'UNDER') return 'AWAY';
  return 'PASS';
}

function moneylineDirectionLabel(row: ProjectionProxyRow): string {
  const side = moneylineProjectedSide(row);
  if (side === 'HOME') return row.homeTeam || 'HOME';
  if (side === 'AWAY') return row.awayTeam || 'AWAY';
  return 'PASS';
}

function moneylineProjectedLabel(row: ProjectionProxyRow): string {
  const side = moneylineDirectionLabel(row);
  if (row.predictionSignalMissing || row.winProbability === null || row.winProbability === undefined) {
    return `${side} (signal missing)`;
  }
  return `${side} (${fmtPct(row.winProbability)})`;
}

function projectionRowKey(row: ProjectionProxyRow, index: number): string {
  if (row.id !== null && row.id !== undefined) {
    return String(row.id);
  }
  if (row.cardId) {
    return `${row.cardId}-${index}`;
  }
  return `${row.gameId || 'unknown-game'}-${index}`;
}

function normalizeToken(value: string | null | undefined): string {
  return String(value ?? '')
    .trim()
    .replace(/\s+/g, ' ')
    .toUpperCase();
}

function toDayKey(value: string | null | undefined): string {
  const raw = String(value ?? '').trim();
  if (!raw) return '';
  const ts = Date.parse(raw);
  if (Number.isFinite(ts)) return new Date(ts).toISOString().slice(0, 10);
  return raw.slice(0, 10);
}

function projectionDisplayDedupKey(row: ProjectionProxyRow): string {
  const family = normalizeToken(row.cardFamily);
  if (family === 'MLB_F5_ML' || family === 'MLB_F5_MONEYLINE') {
    const day = toDayKey(row.gameDateUtc);
    const away = normalizeToken(row.awayTeam);
    const home = normalizeToken(row.homeTeam);
    const side = normalizeToken(row.recommendedSide);
    const outcome = normalizeToken(row.gradedResult);
    if (day && away && home) {
      return [family, day, away, home, side, outcome].join('|');
    }
  }

  return [
    normalizeToken(row.cardFamily),
    toDayKey(row.gameDateUtc),
    normalizeToken(row.awayTeam),
    normalizeToken(row.homeTeam),
    normalizeToken(row.recommendedSide),
    normalizeToken(row.gradedResult),
    row.projValue ?? 'null',
    row.edgeVsLine ?? 'null',
  ].join('|');
}

function confidenceBadgeClass(band: ConfidenceTier): string {
  if (band === 'HIGH')
    return 'border-emerald-500/40 bg-emerald-500/15 text-emerald-200';
  if (band === 'MED')
    return 'border-amber-500/40 bg-amber-500/15 text-amber-200';
  if (band === 'LOW')
    return 'border-white/20 bg-white/5 text-cloud/60';
  return 'border-rose-500/30 bg-rose-500/10 text-rose-200';
}

function outcomeBadgeClass(outcome: 'WIN' | 'LOSS' | 'NO_BET'): string {
  if (outcome === 'WIN')
    return 'border-emerald-500/40 bg-emerald-500/15 text-emerald-200';
  if (outcome === 'LOSS')
    return 'border-rose-500/40 bg-rose-500/15 text-rose-200';
  return 'border-white/20 bg-white/5 text-cloud/50';
}

// ── row renderers ────────────────────────────────────────────────────────────

interface ProjectionRowProps {
  row: ProjectionProxyRow;
  attribution?: ProjectionAccuracyRecord;
}

function ProjectionDetailChips({
  row,
  attribution,
}: ProjectionRowProps) {
  const moneylineFamily = isMoneylineFamily(row.cardFamily);
  const attributionProjectionRaw = fmtNum(attribution?.projection_raw, 3);
  const attributionSyntheticLine = fmtNum(attribution?.synthetic_line ?? row.proxyLine, 3);
  const attributionEdgeDistance = moneylineFamily
    ? fmtPct(row.edgePp ?? attribution?.edge_pp ?? null, 1, { signed: true })
    : fmtNum(attribution?.edge_distance, 3);
  const attributionEdgeLabel = moneylineFamily ? 'edge_pp:' : 'edge_distance:';
  const rawConfidenceBand = normalizeToken(row.confidenceBand || attribution?.confidence_band);
  const legacyConfidenceBand =
    rawConfidenceBand && rawConfidenceBand !== row.confidenceTier
      ? rawConfidenceBand
      : null;
  const confidenceScoreLabel =
    row.confidenceScore !== null && row.confidenceScore !== undefined
      ? `${Math.round(row.confidenceScore)}%`
      : row.predictionSignalMissing
        ? 'MISSING SIGNAL'
        : null;

  return (
    <>
      <span className="rounded-lg border border-white/10 bg-white/5 px-2 py-1 font-mono">
        projection_raw: {attributionProjectionRaw}
      </span>
      <span className="rounded-lg border border-white/10 bg-white/5 px-2 py-1 font-mono">
        synthetic_line: {attributionSyntheticLine}
      </span>
      <span className="rounded-lg border border-white/10 bg-white/5 px-2 py-1 font-mono">
        {attributionEdgeLabel} {attributionEdgeDistance}
      </span>
      {confidenceScoreLabel && (
        <span className="rounded-lg border border-white/10 bg-white/5 px-2 py-1 font-mono">
          confidence_score: {confidenceScoreLabel}
        </span>
      )}
      {legacyConfidenceBand && (
        <span className="rounded-lg border border-white/10 bg-white/5 px-2 py-1 font-mono">
          legacy_band: {legacyConfidenceBand}
        </span>
      )}
    </>
  );
}

function ProjectionDesktopRow({
  row,
  attribution,
  expanded,
  onToggle,
}: ProjectionRowProps & { expanded: boolean; onToggle: () => void }) {
  const date = fmtDate(row.gameDateUtc);
  const moneylineFamily = isMoneylineFamily(row.cardFamily);
  const projected = moneylineFamily
    ? moneylineProjectedLabel(row)
    : fmtNum(row.projValue, 3);
  const edge = moneylineFamily
    ? fmtPct(row.edgePp ?? row.edgeVsLine, 1, { signed: true })
    : row.edgeVsLine === null || row.edgeVsLine === undefined
      ? '—'
      : (row.edgeVsLine >= 0 ? '+' : '') + fmtNum(row.edgeVsLine, 2);
  const actual = moneylineFamily
    ? row.actualValue === 0.5 ? 'PUSH' : row.gradedResult
    : fmtNum(row.actualValue, 3);
  const direction = row.recommendedSide;
  const directionLabel = moneylineFamily ? moneylineDirectionLabel(row) : direction;
  const outcome = row.gradedResult;

  return (
    <>
      <tr className="hidden border-t border-white/10 text-sm text-cloud/70 md:table-row">
        <td className="px-4 py-3 align-middle font-mono text-cloud/60">{date}</td>
        <td className="px-4 py-3 align-middle">
          <div className="max-w-[18rem]">
            <p className="truncate font-medium text-cloud">{fmtMatchup(row)}</p>
            <p className="mt-1 text-xs uppercase tracking-[0.16em] text-cloud/40">
              {row.cardFamily?.replaceAll('_', ' ')}
            </p>
          </div>
        </td>
        <td className="px-4 py-3 text-right font-mono align-middle">{projected}</td>
        <td className="px-4 py-3 text-center align-middle">
          <span
            className={`rounded-full border px-2 py-0.5 text-xs font-semibold ${directionBadgeClass(
              direction,
            )}`}
          >
            {directionLabel}
          </span>
        </td>
        <td className="px-4 py-3 text-center align-middle">
          <span
            className={`rounded-full border px-2 py-0.5 text-xs font-semibold ${confidenceBadgeClass(
              row.confidenceTier,
            )}`}
          >
            {row.confidenceTier}
          </span>
        </td>
        <td className="px-4 py-3 text-right font-mono text-cloud/50 align-middle">{edge}</td>
        <td className="px-4 py-3 text-right font-mono align-middle">{actual}</td>
        <td className="px-4 py-3 text-right align-middle">
          <span
            className={`rounded-full border px-2 py-0.5 text-xs font-semibold ${outcomeBadgeClass(
              outcome,
            )}`}
          >
            {outcome}
          </span>
        </td>
        <td className="px-4 py-3 text-right align-middle">
          <button
            type="button"
            onClick={onToggle}
            className="rounded-full border border-white/10 bg-white/5 px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.14em] text-cloud/70 transition-colors hover:border-cyan-300/50 hover:text-cloud"
          >
            {expanded ? 'Hide' : 'Details'}
          </button>
        </td>
      </tr>
      {expanded && (
        <tr className="hidden bg-night/40 md:table-row">
          <td colSpan={9} className="px-4 py-3">
            <div className="flex flex-wrap gap-2 text-[11px] text-cloud/55">
              <ProjectionDetailChips row={row} attribution={attribution} />
            </div>
            {moneylineFamily && row.expectedOutcomeLabel && (
              <div className="mt-2 text-[11px] uppercase tracking-[0.16em] text-cloud/45">
                Expected vs actual: {row.expectedOutcomeLabel.replaceAll('_', ' ')}
              </div>
            )}
          </td>
        </tr>
      )}
    </>
  );
}

function ProjectionRow({ row, attribution }: ProjectionRowProps) {
  const date = fmtDate(row.gameDateUtc);
  const moneylineFamily = isMoneylineFamily(row.cardFamily);
  const projected = moneylineFamily
    ? moneylineProjectedLabel(row)
    : fmtNum(row.projValue, 3);
  const edge = moneylineFamily
    ? fmtPct(row.edgePp ?? row.edgeVsLine, 1, { signed: true })
    : row.edgeVsLine === null || row.edgeVsLine === undefined
      ? '—'
      : (row.edgeVsLine >= 0 ? '+' : '') + fmtNum(row.edgeVsLine, 2);
  const actual = moneylineFamily
    ? row.actualValue === 0.5 ? 'PUSH' : row.gradedResult
    : fmtNum(row.actualValue, 3);
  const direction = row.recommendedSide;
  const directionLabel = moneylineFamily ? moneylineDirectionLabel(row) : direction;
  const outcome = row.gradedResult;

  return (
    <div className="space-y-2 border-b border-white/10 px-4 py-3 text-sm md:hidden">
        <div className="flex items-start justify-between gap-2">
          <div className="flex-1">
            <p className="text-xs text-cloud/50">{date}</p>
            <p className="mt-0.5 font-medium text-cloud">{fmtMatchup(row)}</p>
          </div>
          <span
            className={`rounded-full border px-2 py-0.5 text-xs font-semibold ${outcomeBadgeClass(
              outcome,
            )}`}
          >
            {outcome}
          </span>
        </div>
        <div className="flex flex-wrap gap-1">
          <span className={`rounded-full border px-2 py-0.5 text-xs ${directionBadgeClass(direction)}`}>
            {directionLabel}
          </span>
          <span
            className={`rounded-full border px-2 py-0.5 text-xs font-semibold ${confidenceBadgeClass(
              row.confidenceTier,
            )}`}
          >
            {row.confidenceTier}
          </span>
        </div>
        <div className="mt-2 grid grid-cols-4 gap-2 text-xs">
          <div className="rounded-lg border border-white/10 bg-white/5 px-2 py-1.5 text-center">
            <p className="font-mono font-semibold text-cloud">{projected}</p>
            <p className="text-cloud/50">Proj</p>
          </div>
          <div className="rounded-lg border border-white/10 bg-white/5 px-2 py-1.5 text-center">
            <p className="font-mono font-semibold text-cloud/60">{edge}</p>
            <p className="text-cloud/50">Edge</p>
          </div>
          <div className="rounded-lg border border-white/10 bg-white/5 px-2 py-1.5 text-center">
            <p className="font-mono font-semibold text-cloud">{actual}</p>
            <p className="text-cloud/50">Actual</p>
          </div>
          <div className="rounded-lg border border-white/10 bg-white/5 px-2 py-1.5 text-center">
            <p className="font-mono font-semibold text-cloud">{fmtNum(row.tierScore)}</p>
            <p className="text-cloud/50">Score</p>
          </div>
        </div>
        <div className="mt-2 flex flex-wrap gap-2 text-[11px] text-cloud/55">
          <ProjectionDetailChips row={row} attribution={attribution} />
        </div>
        {moneylineFamily && row.expectedOutcomeLabel && (
          <div className="text-[11px] uppercase tracking-[0.16em] text-cloud/45">
            Expected vs actual: {row.expectedOutcomeLabel.replaceAll('_', ' ')}
          </div>
        )}
      </div>
  );
}

// ── per-card-family table section ────────────────────────────────────────────

interface CardFamilySectionProps {
  cardFamily: string;
  rows: ProjectionProxyRow[];
  attributionByCardId: Map<string, ProjectionAccuracyRecord>;
}

function familyLabel(cardFamily: string): string {
  const labels: Record<string, string> = {
    NHL_1P_TOTAL: 'NHL 1P Total Projections',
    MLB_F5_TOTAL: 'MLB F5 Total Projections',
    MLB_F5_ML: 'MLB F5 Moneyline Projections',
    MLB_F5_MONEYLINE: 'MLB F5 Moneyline Projections',
    MLB_PITCHER_K: 'MLB Pitcher K Projections',
    NHL_PLAYER_SHOTS: 'NHL Player Shots Projections',
    NHL_PLAYER_SHOTS_1P: 'NHL 1P Player Shots Projections',
    NHL_PLAYER_BLOCKS: 'NHL Player Blocks Projections',
  };
  if (labels[cardFamily]) return labels[cardFamily];
  return `${cardFamily.replaceAll('_', ' ')} Projections`;
}

function CardFamilySection({
  cardFamily,
  rows,
  attributionByCardId,
}: CardFamilySectionProps) {
  const [expandedRowKeys, setExpandedRowKeys] = useState<Set<string>>(new Set());

  function toggleRow(rowKey: string) {
    setExpandedRowKeys((current) => {
      const next = new Set(current);
      if (next.has(rowKey)) {
        next.delete(rowKey);
      } else {
        next.add(rowKey);
      }
      return next;
    });
  }

  return (
    <div>
      <div className="mb-3 flex items-center justify-between gap-3">
        <h3 className="text-lg font-semibold text-cloud">{familyLabel(cardFamily)}</h3>
        <span className="text-xs uppercase tracking-[0.2em] text-cloud/50">
          {rows.length} settled
        </span>
      </div>

      <div className="overflow-hidden rounded-xl border border-white/10 bg-night/20">
        <div className="hidden overflow-x-auto md:block">
          <table className="min-w-full table-fixed border-collapse">
            <thead className="bg-night/70 text-xs font-semibold uppercase tracking-[0.2em] text-cloud/60">
              <tr>
                <th className="w-[8rem] px-4 py-3 text-left">Date</th>
                <th className="px-4 py-3 text-left">Matchup</th>
                <th className="w-[9rem] px-4 py-3 text-right">Projected</th>
                <th className="w-[9rem] px-4 py-3 text-center">Direction</th>
                <th className="w-[8rem] px-4 py-3 text-center">Confidence</th>
                <th className="w-[8rem] px-4 py-3 text-right">Edge</th>
                <th className="w-[8rem] px-4 py-3 text-right">Actual</th>
                <th className="w-[8rem] px-4 py-3 text-right">Outcome</th>
                <th className="w-[8rem] px-4 py-3 text-right">Detail</th>
              </tr>
            </thead>
            {rows.length > 0 && (
              <tbody>
                {rows.map((row, index) => {
                  const rowKey = projectionRowKey(row, index);
                  return (
                    <ProjectionDesktopRow
                      key={rowKey}
                      row={row}
                      attribution={attributionByCardId.get(String(row.cardId || ''))}
                      expanded={expandedRowKeys.has(rowKey)}
                      onToggle={() => toggleRow(rowKey)}
                    />
                  );
                })}
              </tbody>
            )}
          </table>
        </div>

        {rows.length === 0 ? (
          <div className="px-4 py-6 text-sm text-cloud/60">
            No settled projection records yet. Records appear here after games
            complete and actuals are ingested.
          </div>
        ) : (
          <div className="divide-y divide-white/10 md:hidden">
            {rows.map((row, index) => (
              <ProjectionRow
                key={projectionRowKey(row, index)}
                row={row}
                attribution={attributionByCardId.get(String(row.cardId || ''))}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ── public component ─────────────────────────────────────────────────────────

interface ProjectionResultsTableProps {
  rows: ProjectionProxyRow[];
  attributionRows?: ProjectionAccuracyRecord[];
  confidenceFilter?: 'ALL' | ConfidenceTier;
}

export function ProjectionResultsTable({
  rows,
  attributionRows = [],
  confidenceFilter = 'ALL',
}: ProjectionResultsTableProps) {
  if (rows.length === 0) {
    return (
      <div className="rounded-xl border border-white/10 bg-night/30 px-4 py-8 text-center text-sm text-cloud/60">
        No settled projection records yet. Records appear here after games
        complete and actuals are ingested.
      </div>
    );
  }

  // Defensive UI dedupe: keep first row for a canonical display key so stale
  // mixed payloads do not render repeated matchup entries.
  const dedupedRows = Array.from(
    new Map(rows.map((row) => [projectionDisplayDedupKey(row), row] as const)).values(),
  );
  const visibleRows =
    confidenceFilter === 'ALL'
      ? dedupedRows
      : dedupedRows.filter((row) => row.confidenceTier === confidenceFilter);

  const groupedRows = visibleRows.reduce<Map<string, ProjectionProxyRow[]>>((groups, row) => {
    const key = row.cardFamily || 'UNKNOWN';
    const group = groups.get(key);
    if (group) {
      group.push(row);
    } else {
      groups.set(key, [row]);
    }
    return groups;
  }, new Map());

  const attributionByCardId = attributionRows.reduce<Map<string, ProjectionAccuracyRecord>>(
    (map, row) => {
      const cardId = String(row.card_id || '').trim();
      if (!cardId || map.has(cardId)) return map;
      map.set(cardId, row);
      return map;
    },
    new Map(),
  );

  if (visibleRows.length === 0) {
    return (
      <div className="rounded-xl border border-white/10 bg-night/30 px-4 py-8 text-center text-sm text-cloud/60">
        No settled projection records match the selected confidence tier yet.
      </div>
    );
  }

  return (
    <div className="mt-6 space-y-8">
      {Array.from(groupedRows.entries()).map(([cardFamily, familyRows]) => (
        <CardFamilySection
          key={cardFamily}
          cardFamily={cardFamily}
          rows={familyRows}
          attributionByCardId={attributionByCardId}
        />
      ))}
    </div>
  );
}
