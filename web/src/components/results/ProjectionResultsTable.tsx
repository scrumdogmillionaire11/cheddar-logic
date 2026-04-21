'use client';

import type { ProjectionProxyRow } from '@/app/api/results/projection-settled/route';
import type { ProjectionAccuracyRecord } from '@/lib/types/projection-accuracy';

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

function projectionRowKey(row: ProjectionProxyRow, index: number): string {
  if (row.id !== null && row.id !== undefined) {
    return String(row.id);
  }
  if (row.cardId) {
    return `${row.cardId}-${index}`;
  }
  return `${row.gameId || 'unknown-game'}-${index}`;
}

function tierBadgeClass(tier: 'PLAY' | 'LEAN' | 'STRONG' | 'PASS'): string {
  if (tier === 'PLAY')
    return 'border-blue-500/60 bg-blue-500/25 text-blue-100 font-semibold';
  if (tier === 'LEAN')
    return 'border-blue-500/40 bg-blue-500/15 text-blue-200';
  if (tier === 'STRONG')
    return 'border-blue-600/70 bg-blue-600/30 text-blue-50 font-bold';
  return 'border-white/20 bg-white/5 text-cloud/50';
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

function ProjectionRow({ row, attribution }: ProjectionRowProps) {
  const date = fmtDate(row.gameDateUtc);
  const moneylineFamily = isMoneylineFamily(row.cardFamily);
  const projected = moneylineFamily
    ? moneylineProjectedSide(row)
    : fmtNum(row.projValue, 3);
  const edge = (row.edgeVsLine >= 0 ? '+' : '') + fmtNum(row.edgeVsLine, 2);
  const actual = fmtNum(row.actualValue, 3);
  const direction = row.recommendedSide;
  const directionLabel = moneylineFamily ? moneylineDirectionLabel(row) : direction;
  const tier = row.tier;
  const outcome = row.gradedResult;
  const attributionProjectionRaw = fmtNum(attribution?.projection_raw, 3);
  const attributionSyntheticLine = fmtNum(attribution?.synthetic_line, 3);
  const attributionEdgeDistance = fmtNum(attribution?.edge_distance, 3);
  const attributionBand = attribution?.confidence_band || 'UNKNOWN';

  return (
    <>
      {/* Desktop row */}
      <div className="hidden px-4 py-3 text-sm text-cloud/70 md:block">
        <div className="grid grid-cols-9 gap-3">
          <span>{date}</span>
          <span className="col-span-2 truncate">{fmtMatchup(row)}</span>
          <span className="text-right font-mono">{projected}</span>
          <span className="flex justify-center">
            <span
              className={`rounded-full border px-2 py-0.5 text-xs font-semibold ${directionBadgeClass(
                direction,
              )}`}
            >
              {directionLabel}
            </span>
          </span>
          <span className="flex justify-center">
            <span className={`rounded-full border px-2 py-0.5 text-xs ${tierBadgeClass(tier)}`}>
              {tier}
            </span>
          </span>
          <span className="text-right font-mono text-cloud/50">{edge}</span>
          <span className="text-right font-mono">{actual}</span>
          <span className="flex justify-end">
            <span
              className={`rounded-full border px-2 py-0.5 text-xs font-semibold ${outcomeBadgeClass(
                outcome,
              )}`}
            >
              {outcome}
            </span>
          </span>
        </div>
        <div className="mt-2 grid grid-cols-4 gap-2 text-[11px] text-cloud/55">
          <span className="rounded-lg border border-white/10 bg-white/5 px-2 py-1 font-mono">
            projection_raw: {attributionProjectionRaw}
          </span>
          <span className="rounded-lg border border-white/10 bg-white/5 px-2 py-1 font-mono">
            synthetic_line: {attributionSyntheticLine}
          </span>
          <span className="rounded-lg border border-white/10 bg-white/5 px-2 py-1 font-mono">
            edge_distance: {attributionEdgeDistance}
          </span>
          <span className="rounded-lg border border-white/10 bg-white/5 px-2 py-1 font-mono">
            confidence_band: {attributionBand}
          </span>
        </div>
      </div>

      {/* Mobile card */}
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
          <span className={`rounded-full border px-2 py-0.5 text-xs ${tierBadgeClass(tier)}`}>
            {tier}
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
        <div className="mt-2 grid grid-cols-2 gap-2 text-[11px] text-cloud/55">
          <span className="rounded-lg border border-white/10 bg-white/5 px-2 py-1 font-mono">
            projection_raw: {attributionProjectionRaw}
          </span>
          <span className="rounded-lg border border-white/10 bg-white/5 px-2 py-1 font-mono">
            synthetic_line: {attributionSyntheticLine}
          </span>
          <span className="rounded-lg border border-white/10 bg-white/5 px-2 py-1 font-mono">
            edge_distance: {attributionEdgeDistance}
          </span>
          <span className="rounded-lg border border-white/10 bg-white/5 px-2 py-1 font-mono">
            confidence_band: {attributionBand}
          </span>
        </div>
      </div>
    </>
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
  const headers = (
    <div className="grid grid-cols-9 gap-3 bg-night/70 px-4 py-3 text-xs font-semibold uppercase tracking-[0.2em] text-cloud/60">
      <span>Date</span>
      <span className="col-span-2">Matchup</span>
      <span className="text-right">Projected</span>
      <span className="text-center">Direction</span>
      <span className="text-center">Tier</span>
      <span className="text-right">Edge</span>
      <span className="text-right">Actual</span>
      <span className="text-right">Outcome</span>
    </div>
  );

  return (
    <div>
      <div className="mb-3 flex items-center justify-between gap-3">
        <h3 className="text-lg font-semibold text-cloud">{familyLabel(cardFamily)}</h3>
        <span className="text-xs uppercase tracking-[0.2em] text-cloud/50">
          {rows.length} settled
        </span>
      </div>

      <div className="overflow-hidden rounded-xl border border-white/10">
        {/* headers — desktop only */}
        <div className="hidden md:block">
          {headers}
        </div>

        {rows.length === 0 ? (
          <div className="px-4 py-6 text-sm text-cloud/60">
            No settled projection records yet. Records appear here after games
            complete and actuals are ingested.
          </div>
        ) : (
          <div className="divide-y divide-white/10 md:divide-y-0">
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
}

export function ProjectionResultsTable({
  rows,
  attributionRows = [],
}: ProjectionResultsTableProps) {
  if (rows.length === 0) {
    return (
      <div className="rounded-xl border border-white/10 bg-night/30 px-4 py-8 text-center text-sm text-cloud/60">
        No settled projection records yet. Records appear here after games
        complete and actuals are ingested.
      </div>
    );
  }

  const groupedRows = rows.reduce<Map<string, ProjectionProxyRow[]>>((groups, row) => {
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
