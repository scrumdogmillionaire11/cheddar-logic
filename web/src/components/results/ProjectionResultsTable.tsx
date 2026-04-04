'use client';

import type { ProjectionSettledRow } from '@/app/api/results/projection-settled/route';

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
  row: ProjectionSettledRow,
): string {
  if (row.homeTeam && row.awayTeam) {
    return `${row.awayTeam} @ ${row.homeTeam}`;
  }
  return row.cardTitle || row.gameId;
}

function outcomeBadgeClass(outcome: 'HIT' | 'MISS' | null): string {
  if (outcome === 'HIT')
    return 'border-emerald-500/40 bg-emerald-500/15 text-emerald-200';
  if (outcome === 'MISS')
    return 'border-rose-500/40 bg-rose-500/15 text-rose-200';
  return 'border-white/20 bg-white/5 text-cloud/50';
}

const CARD_LABEL: Record<string, string> = {
  'nhl-pace-1p': 'NHL 1P Total',
  'mlb-f5': 'MLB F5',
};

// ── row renderers ────────────────────────────────────────────────────────────

interface NhlRowProps {
  row: ProjectionSettledRow;
}

function NhlPaceRow({ row }: NhlRowProps) {
  const date = fmtDate(row.gameTimeUtc ?? row.createdAt);
  const projected = fmtNum(row.modelProjection);
  const line = row.line !== null ? row.line.toFixed(1) : '1.5';
  const actual =
    row.actualValue !== null ? row.actualValue.toString() : '—';
  const outcomeLabel = row.outcome ?? 'PENDING';

  return (
    <>
      {/* Desktop row */}
      <div className="hidden grid-cols-7 gap-4 px-4 py-3 text-sm text-cloud/70 md:grid">
        <span>{date}</span>
        <span className="col-span-2 truncate">{fmtMatchup(row)}</span>
        <span className="text-right font-mono">{projected}</span>
        <span className="text-right font-mono text-cloud/50">o/u {line}</span>
        <span className="text-right font-mono">{actual}</span>
        <span className="flex justify-end">
          <span
            className={`rounded-full border px-2 py-0.5 text-xs font-semibold ${outcomeBadgeClass(
              row.outcome,
            )}`}
          >
            {outcomeLabel}
          </span>
        </span>
      </div>

      {/* Mobile card */}
      <div className="space-y-1 border-b border-white/10 px-4 py-3 text-sm md:hidden">
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="text-xs text-cloud/50">{date}</p>
            <p className="mt-0.5 font-medium text-cloud">{fmtMatchup(row)}</p>
          </div>
          <span
            className={`rounded-full border px-2 py-0.5 text-xs font-semibold ${outcomeBadgeClass(
              row.outcome,
            )}`}
          >
            {outcomeLabel}
          </span>
        </div>
        <div className="mt-2 grid grid-cols-3 gap-2 text-xs">
          <div className="rounded-lg border border-white/10 bg-white/5 px-2 py-1.5 text-center">
            <p className="font-mono font-semibold text-cloud">{projected}</p>
            <p className="text-cloud/50">Projected</p>
          </div>
          <div className="rounded-lg border border-white/10 bg-white/5 px-2 py-1.5 text-center">
            <p className="font-mono font-semibold text-cloud">o/u {line}</p>
            <p className="text-cloud/50">Line</p>
          </div>
          <div className="rounded-lg border border-white/10 bg-white/5 px-2 py-1.5 text-center">
            <p className={`font-mono font-semibold ${actual === '—' ? 'text-cloud/50' : 'text-cloud'}`}>{actual}</p>
            <p className="text-cloud/50">Actual</p>
          </div>
        </div>
      </div>
    </>
  );
}

interface MlbF5RowProps {
  row: ProjectionSettledRow;
}

function MlbF5Row({ row }: MlbF5RowProps) {
  const date = fmtDate(row.gameTimeUtc ?? row.createdAt);
  const projected = fmtNum(row.modelProjection);
  const actual =
    row.actualValue !== null ? fmtNum(row.actualValue) : '—';
  const errorLabel =
    row.delta !== null
      ? `|${fmtNum(row.modelProjection)} − ${fmtNum(row.actualValue)}| = ${fmtNum(row.delta)}`
      : '—';

  return (
    <>
      {/* Desktop row */}
      <div className="hidden grid-cols-6 gap-4 px-4 py-3 text-sm text-cloud/70 md:grid">
        <span>{date}</span>
        <span className="col-span-2 truncate">{fmtMatchup(row)}</span>
        <span className="text-right font-mono">{projected}</span>
        <span className="text-right font-mono">{actual}</span>
        <span className="text-right font-mono text-cloud/50">{errorLabel}</span>
      </div>

      {/* Mobile card */}
      <div className="space-y-1 border-b border-white/10 px-4 py-3 text-sm md:hidden">
        <div>
          <p className="text-xs text-cloud/50">{date}</p>
          <p className="mt-0.5 font-medium text-cloud">{fmtMatchup(row)}</p>
        </div>
        <div className="mt-2 grid grid-cols-3 gap-2 text-xs">
          <div className="rounded-lg border border-white/10 bg-white/5 px-2 py-1.5 text-center">
            <p className="font-mono font-semibold text-cloud">{projected}</p>
            <p className="text-cloud/50">Projected</p>
          </div>
          <div className="rounded-lg border border-white/10 bg-white/5 px-2 py-1.5 text-center">
            <p className={`font-mono font-semibold ${actual === '—' ? 'text-cloud/50' : 'text-cloud'}`}>{actual}</p>
            <p className="text-cloud/50">Actual</p>
          </div>
          <div className="rounded-lg border border-white/10 bg-white/5 px-2 py-1.5 text-center">
            <p className="font-mono font-semibold text-cloud/50">{row.delta !== null ? fmtNum(row.delta) : '—'}</p>
            <p className="text-cloud/50">Error</p>
          </div>
        </div>
      </div>
    </>
  );
}

// ── per-card-type table section ──────────────────────────────────────────────

interface CardTypeSectionProps {
  cardType: 'nhl-pace-1p' | 'mlb-f5';
  rows: ProjectionSettledRow[];
}

function CardTypeSection({ cardType, rows }: CardTypeSectionProps) {
  const label = CARD_LABEL[cardType] ?? cardType;

  const nhlHeaders = (
    <div className="grid grid-cols-7 gap-4 bg-night/70 px-4 py-3 text-xs font-semibold uppercase tracking-[0.2em] text-cloud/60">
      <span>Date</span>
      <span className="col-span-2">Matchup</span>
      <span className="text-right">Projected</span>
      <span className="text-right">Line</span>
      <span className="text-right">Actual</span>
      <span className="text-right">Outcome</span>
    </div>
  );

  const mlbHeaders = (
    <div className="grid grid-cols-6 gap-4 bg-night/70 px-4 py-3 text-xs font-semibold uppercase tracking-[0.2em] text-cloud/60">
      <span>Date</span>
      <span className="col-span-2">Matchup</span>
      <span className="text-right">Projected</span>
      <span className="text-right">Actual</span>
      <span className="text-right">Error</span>
    </div>
  );

  return (
    <div>
      <div className="mb-3 flex items-center justify-between gap-3">
        <h3 className="text-lg font-semibold text-cloud">{label}</h3>
        <span className="text-xs uppercase tracking-[0.2em] text-cloud/50">
          {rows.length} settled
        </span>
      </div>

      <div className="overflow-hidden rounded-xl border border-white/10">
        {/* headers — desktop only */}
        <div className="hidden md:block">
          {cardType === 'nhl-pace-1p' ? nhlHeaders : mlbHeaders}
        </div>

        {rows.length === 0 ? (
          <div className="px-4 py-6 text-sm text-cloud/60">
            No settled records yet for this model.
          </div>
        ) : (
          <div className="divide-y divide-white/10 md:divide-y-0">
            {rows.map((row) =>
              cardType === 'nhl-pace-1p' ? (
                <NhlPaceRow key={row.id} row={row} />
              ) : (
                <MlbF5Row key={row.id} row={row} />
              ),
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ── public component ─────────────────────────────────────────────────────────

interface ProjectionResultsTableProps {
  rows: ProjectionSettledRow[];
}

export function ProjectionResultsTable({ rows }: ProjectionResultsTableProps) {
  const nhlRows = rows.filter((r) => r.cardType === 'nhl-pace-1p');
  const mlbRows = rows.filter((r) => r.cardType === 'mlb-f5');

  if (rows.length === 0) {
    return (
      <div className="rounded-xl border border-white/10 bg-night/30 px-4 py-8 text-center text-sm text-cloud/60">
        No settled projection records yet. Records appear here after games
        complete and actuals are ingested.
      </div>
    );
  }

  return (
    <div className="mt-6 space-y-8">
      {nhlRows.length > 0 && (
        <CardTypeSection cardType="nhl-pace-1p" rows={nhlRows} />
      )}
      {mlbRows.length > 0 && (
        <CardTypeSection cardType="mlb-f5" rows={mlbRows} />
      )}
    </div>
  );
}
