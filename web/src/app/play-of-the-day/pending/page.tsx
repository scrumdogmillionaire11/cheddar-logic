import type { Metadata } from 'next';
import Link from 'next/link';
import { StickyBackButton } from '@/components/sticky-back-button';
import { getPotdPendingData } from '@/lib/potd-server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'POTD Pending Games | Cheddar Logic',
  description: 'Near-miss candidates still awaiting settlement.',
};

function formatPercent(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) return 'N/A';
  return `${(value * 100).toFixed(1)}%`;
}

export default async function PotdPendingGamesPage() {
  const pendingData = await getPotdPendingData().catch((error) => {
    console.error('[PotdPendingGamesPage] Failed to load pending data:', error);
    return {
      pendingCount: 0,
      pending: [],
      loadError: true,
    };
  });

  const { pendingCount, pending } = pendingData;
  const loadError = 'loadError' in pendingData;

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
                Pending Games
              </h1>
              <p className="mt-3 text-sm text-cloud/65">
                Near-miss candidates still awaiting settlement.
              </p>
            </div>
            <div className="flex items-center gap-3">
              <span className="rounded-full border border-teal/35 bg-teal/10 px-4 py-2 text-sm font-semibold text-teal-100">
                {pendingCount} pending
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

        {loadError ? (
          <section className="rounded-[28px] border border-dashed border-white/15 bg-surface/70 p-8 text-sm text-cloud/65">
            Unable to load pending games. Please try again later.
          </section>
        ) : pending.length === 0 ? (
          <section className="rounded-[28px] border border-dashed border-white/15 bg-surface/70 p-8 text-sm text-cloud/65">
            No pending near-miss games found.
          </section>
        ) : (
          <section className="space-y-3">
            {pending.map((row) => (
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
                    <span className="rounded-full border border-amber-500/40 bg-amber-500/15 px-2.5 py-1 text-[11px] font-semibold tracking-[0.2em] text-amber-200">
                      PENDING
                    </span>
                    <span className="text-xs text-cloud/50">{row.playDate}</span>
                  </div>
                </div>

                <div className="mt-4 grid gap-3 text-sm text-cloud/70 sm:grid-cols-4">
                  <div>
                    <div className="text-[11px] uppercase tracking-[0.18em] text-cloud/45">Sport</div>
                    <div className="mt-1">{row.sport}</div>
                  </div>
                  <div>
                    <div className="text-[11px] uppercase tracking-[0.18em] text-cloud/45">Market</div>
                    <div className="mt-1">{row.marketType}</div>
                  </div>
                  <div>
                    <div className="text-[11px] uppercase tracking-[0.18em] text-cloud/45">Game Time</div>
                    <div className="mt-1">{row.gameTimeEtLabel}</div>
                  </div>
                  <div>
                    <div className="text-[11px] uppercase tracking-[0.18em] text-cloud/45">Edge</div>
                    <div className="mt-1">{formatPercent(row.edgePct)}</div>
                  </div>
                </div>
              </article>
            ))}
          </section>
        )}
      </main>
    </div>
  );
}
