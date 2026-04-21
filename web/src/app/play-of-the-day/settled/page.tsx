import type { Metadata } from 'next';
import Link from 'next/link';
import { closeDatabaseReadOnly } from '@cheddar-logic/data';
import { StickyBackButton } from '@/components/sticky-back-button';
import { getPotdSettledHistoryData } from '@/lib/potd-server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'POTD Settled Games | Cheddar Logic',
  description:
    'Near-Miss settled game history behind POTD Settled tracking.',
};

function formatSignedUnits(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) return '0.00u';
  const absolute = `${Math.abs(value).toFixed(2)}u`;
  if (value > 0) return `+${absolute}`;
  if (value < 0) return `-${absolute}`;
  return absolute;
}

function formatPercent(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) return 'N/A';
  return `${(value * 100).toFixed(1)}%`;
}

function formatResultLabel(result: string | null | undefined): 'WIN' | 'LOSS' | 'PUSH' | 'PENDING' {
  const normalized = String(result || '').trim().toUpperCase();
  if (normalized === 'WIN') return 'WIN';
  if (normalized === 'LOSS') return 'LOSS';
  if (normalized === 'PUSH') return 'PUSH';
  return 'PENDING';
}

function resultBadgeClass(result: 'WIN' | 'LOSS' | 'PUSH' | 'PENDING'): string {
  if (result === 'WIN') {
    return 'border-emerald-500/40 bg-emerald-500/15 text-emerald-200';
  }
  if (result === 'LOSS') {
    return 'border-rose-500/40 bg-rose-500/15 text-rose-200';
  }
  if (result === 'PUSH') {
    return 'border-amber-500/40 bg-amber-500/15 text-amber-200';
  }
  return 'border-white/15 bg-white/5 text-cloud/60';
}

function metricTone(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) return 'text-cloud';
  if (value > 0) return 'text-emerald-300';
  if (value < 0) return 'text-rose-300';
  return 'text-cloud';
}

export default async function PotdSettledGamesPage() {
  try {
    const { settledCount, settled } = await getPotdSettledHistoryData();

    return (
      <div className="min-h-screen bg-night px-4 py-8 text-cloud sm:px-6 lg:px-8">
        <StickyBackButton fallbackHref="/play-of-the-day" fallbackLabel="POTD" />

        <main className="mx-auto flex max-w-6xl flex-col gap-6">
          <section className="rounded-[28px] border border-white/10 bg-surface/80 p-6">
            <div className="flex flex-wrap items-center justify-between gap-4">
              <div>
                <p className="text-[11px] uppercase tracking-[0.22em] text-cloud/50">
                  Play of the Day
                </p>
                <h1 className="mt-2 font-display text-4xl font-semibold text-cloud sm:text-5xl">
                  Settled Games
                </h1>
                <p className="mt-3 text-sm text-cloud/65">
                  Near-Miss settled history (source of the Settled metric on POTD).
                </p>
              </div>
              <div className="flex items-center gap-3">
                <span className="rounded-full border border-teal/35 bg-teal/10 px-4 py-2 text-sm font-semibold text-teal-100">
                  {settledCount} near-miss settled
                </span>
                <Link
                  href="/play-of-the-day"
                  className="rounded-full border border-white/20 px-4 py-2 text-sm font-medium text-cloud/80 transition hover:border-white/35 hover:text-cloud"
                >
                  Back to POTD
                </Link>
              </div>
            </div>
          </section>

          {settled.length === 0 ? (
            <section className="rounded-[28px] border border-dashed border-white/15 bg-surface/70 p-8 text-sm text-cloud/65">
              No settled Near-Miss games found yet.
            </section>
          ) : (
            <section className="space-y-3">
              {settled.map((row) => {
                const result = formatResultLabel(row.result);
                return (
                  <article
                    key={row.id}
                    className="rounded-2xl border border-white/10 bg-surface/80 p-4"
                  >
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div>
                        <div className="text-sm font-semibold text-cloud">{row.selectionLabel}</div>
                        <div className="mt-1 text-xs text-cloud/55">
                          {row.awayTeam} @ {row.homeTeam}
                        </div>
                      </div>
                      <div className="flex items-center gap-2">
                        <span
                          className={`rounded-full border px-2.5 py-1 text-[11px] font-semibold tracking-[0.2em] ${resultBadgeClass(
                            result,
                          )}`}
                        >
                          {result}
                        </span>
                        <span className="text-xs text-cloud/50">{row.playDate}</span>
                      </div>
                    </div>

                    <div className="mt-4 grid gap-3 text-sm text-cloud/70 sm:grid-cols-5">
                      <div>
                        <div className="text-[11px] uppercase tracking-[0.18em] text-cloud/45">Sport</div>
                        <div className="mt-1">{row.sport}</div>
                      </div>
                      <div>
                        <div className="text-[11px] uppercase tracking-[0.18em] text-cloud/45">Game Time</div>
                        <div className="mt-1">{row.gameTimeEtLabel}</div>
                      </div>
                      <div>
                        <div className="text-[11px] uppercase tracking-[0.18em] text-cloud/45">Edge</div>
                        <div className="mt-1">{formatPercent(row.edgePct)}</div>
                      </div>
                      <div>
                        <div className="text-[11px] uppercase tracking-[0.18em] text-cloud/45">Stake</div>
                        <div className="mt-1">{row.virtualStakeUnits === null ? 'N/A' : `${row.virtualStakeUnits.toFixed(2)}u`}</div>
                      </div>
                      <div>
                        <div className="text-[11px] uppercase tracking-[0.18em] text-cloud/45">P&L (u)</div>
                        <div className={`mt-1 font-medium ${metricTone(row.pnlUnits)}`}>
                          {formatSignedUnits(row.pnlUnits)}
                        </div>
                      </div>
                    </div>
                  </article>
                );
              })}
            </section>
          )}
        </main>
      </div>
    );
  } finally {
    try {
      closeDatabaseReadOnly();
    } catch (error) {
      console.warn(
        '[play-of-the-day/settled] closeDatabaseReadOnly failed during page teardown',
        error,
      );
    }
  }
}
