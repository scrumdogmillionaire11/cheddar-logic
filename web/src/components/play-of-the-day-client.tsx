'use client';

import Link from 'next/link';
import { StickyBackButton } from '@/components/sticky-back-button';

type PotdApiPlay = {
  id: string;
  playDate: string;
  gameId: string;
  cardId: string;
  sport: string;
  homeTeam: string;
  awayTeam: string;
  marketType: string;
  selection: string;
  selectionLabel: string;
  line: number | null;
  price: number;
  confidenceLabel: string;
  totalScore: number;
  modelWinProb: number;
  impliedProb: number;
  edgePct: number;
  scoreBreakdown: Record<string, unknown>;
  wagerAmount: number;
  bankrollAtPost: number;
  kellyFraction: number;
  gameTimeUtc: string;
  gameTimeEtLabel: string;
  postedAt: string;
  discordPosted: boolean;
  discordPostedAt: string | null;
  result: string | null;
  settledAt: string | null;
  pnlDollars: number | null;
  reasoning: string | null;
};

type PotdBankrollSummary = {
  current: number;
  starting: number;
  netProfit: number;
  postedCount: number;
  settledCount: number;
  wins: number;
  losses: number;
  pushes: number;
  winRate: number | null;
  roi: number | null;
};

type PotdNearMissSummary = {
  sampleSize: number;
  settledCount: number;
  wins: number;
  losses: number;
  pushes: number;
  pending: number;
  nonGradeable: number;
  winRate: number | null;
};

type PotdSchedule = {
  playDate: string;
  published: boolean;
  earliestGameTimeUtc: string;
  earliestGameTimeEtLabel: string;
  targetPostTimeUtc: string;
  targetPostTimeEtLabel: string;
  windowStartTimeUtc: string;
  windowStartTimeEtLabel: string;
  windowEndTimeUtc: string;
  windowEndTimeEtLabel: string;
};

type PotdNominee = {
  rank: number;
  winnerStatus: string;
  sport: string;
  gameId: string | null;
  homeTeam: string | null;
  awayTeam: string | null;
  marketType: string | null;
  selectionLabel: string | null;
  line: number | null;
  price: number | null;
  edgePct: number | null;
  totalScore: number | null;
  confidenceLabel: string | null;
  modelWinProb: number | null;
  gameTimeUtc: string | null;
  gameTimeEtLabel: string;
};

type PotdResponseData = {
  featuredPick: PotdApiPlay | null;
  today: PotdApiPlay | null;
  history: PotdApiPlay[];
  bankroll: PotdBankrollSummary;
  schedule: PotdSchedule | null;
  nominees: PotdNominee[];
  diagnosticNominees: PotdNominee[];
  nearMissSummary: PotdNearMissSummary;
  winnerStatus: 'FIRED' | 'NO_PICK' | null;
};

type PlayOfTheDayClientProps = {
  initialData: PotdResponseData;
};

function formatCurrency(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) return '$0.00';
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
  }).format(value);
}

function formatPercent(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) return 'N/A';
  return `${(value * 100).toFixed(1)}%`;
}

function formatNomineeEdgeLabel(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) return 'N/A';
  if (Math.abs(value) < 0.001) return 'N/A';
  if (value <= 0) return 'No positive edge';
  return formatPercent(value);
}

function formatSignedDollars(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) return '$0.00';
  const absolute = formatCurrency(Math.abs(value));
  if (value > 0) return `+${absolute}`;
  if (value < 0) return `-${absolute}`;
  return absolute;
}

function formatPrice(value: number): string {
  return value > 0 ? `+${value}` : String(value);
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

function bankrollStat(label: string, value: string, tone = 'text-cloud') {
  return (
    <div className="rounded-2xl border border-white/10 bg-night/40 p-4">
      <div className="text-[11px] uppercase tracking-[0.22em] text-cloud/50">
        {label}
      </div>
      <div className={`mt-2 text-2xl font-semibold ${tone}`}>{value}</div>
    </div>
  );
}

function renderTodayCard(today: PotdApiPlay) {
  const result = formatResultLabel(today.result);

  return (
    <section className="rounded-[28px] border border-teal/30 bg-[radial-gradient(circle_at_top,rgba(45,212,191,0.22),rgba(10,16,28,0.96)_56%)] p-6 shadow-[0_30px_80px_rgba(0,0,0,0.28)]">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="text-[11px] uppercase tracking-[0.26em] text-teal-100/80">
            Today&apos;s Card
          </p>
          <h1 className="mt-2 font-display text-4xl font-semibold text-cloud sm:text-5xl">
            Play of the Day
          </h1>
          <p className="mt-3 text-base text-cloud/75">
            {today.awayTeam} @ {today.homeTeam}
          </p>
        </div>
        <div className="flex items-center gap-3">
          <span
            className={`rounded-full border px-3 py-1 text-xs font-semibold tracking-[0.22em] ${resultBadgeClass(
              result,
            )}`}
          >
            {result}
          </span>
          <span className="rounded-full border border-white/15 bg-white/5 px-3 py-1 text-xs font-semibold tracking-[0.22em] text-cloud/70">
            {today.confidenceLabel}
          </span>
        </div>
      </div>

      <div className="mt-8 grid gap-4 md:grid-cols-[minmax(0,1.5fr)_minmax(260px,1fr)]">
        <div className="rounded-3xl border border-white/12 bg-night/45 p-5">
          <p className="text-sm uppercase tracking-[0.18em] text-cloud/55">
            Pick
          </p>
          <div className="mt-3 text-3xl font-semibold text-cloud">
            {today.selectionLabel}
          </div>
          <div className="mt-2 text-sm text-cloud/65">
            {today.marketType} at {formatPrice(today.price)} • {today.gameTimeEtLabel}
          </div>

          <div className="mt-6 grid gap-3 sm:grid-cols-2">
            <div className="rounded-2xl border border-white/10 bg-white/5 p-4">
              <div className="text-[11px] uppercase tracking-[0.22em] text-cloud/50">
                Wager
              </div>
              <div className="mt-2 text-xl font-semibold text-cloud">
                {formatCurrency(today.wagerAmount)}
              </div>
              <div className="mt-1 text-xs text-cloud/60">
                From a {formatCurrency(today.bankrollAtPost)} bankroll
              </div>
            </div>

            <div className="rounded-2xl border border-white/10 bg-white/5 p-4">
              <div className="text-[11px] uppercase tracking-[0.22em] text-cloud/50">
                Edge
              </div>
              <div className="mt-2 text-xl font-semibold text-cloud">
                {formatPercent(today.edgePct)}
              </div>
              <div className="mt-1 text-xs text-cloud/60">
                Model win probability {formatPercent(today.modelWinProb)}
              </div>
            </div>
          </div>
        </div>

        <div className="rounded-3xl border border-white/12 bg-night/45 p-5">
          <p className="text-sm uppercase tracking-[0.18em] text-cloud/55">
            Posting Window
          </p>
          <div className="mt-4 space-y-3 text-sm text-cloud/75">
            <div className="flex items-center justify-between gap-3">
              <span>Published</span>
              <span className="font-medium text-cloud">
                {today.postedAt ? 'Yes' : 'No'}
              </span>
            </div>
            <div className="flex items-center justify-between gap-3">
              <span>Discord</span>
              <span className="font-medium text-cloud">
                {today.discordPosted ? 'Posted' : 'Skipped'}
              </span>
            </div>
            <div className="flex items-center justify-between gap-3">
              <span>Posted at</span>
              <span className="text-right font-medium text-cloud">
                {today.postedAt ? new Date(today.postedAt).toLocaleString() : '--'}
              </span>
            </div>
            <div className="flex items-center justify-between gap-3">
              <span>Card ID</span>
              <span className="max-w-[180px] truncate text-right font-medium text-cloud">
                {today.cardId}
              </span>
            </div>
          </div>
        </div>
      </div>

      {today.reasoning && (
        <div className="mt-4 rounded-2xl border border-white/10 bg-white/5 p-4">
          <div className="text-[11px] uppercase tracking-[0.22em] text-cloud/50">
            Reasoning
          </div>
          <div className="mt-2 text-sm text-cloud/75">{today.reasoning}</div>
        </div>
      )}
    </section>
  );
}

function renderEmptyState(
  schedule: PotdSchedule | null,
  winnerStatus: 'FIRED' | 'NO_PICK' | null,
) {
  const isNoPick = winnerStatus === 'NO_PICK';

  return (
    <section className="rounded-[28px] border border-white/10 bg-[linear-gradient(135deg,rgba(255,255,255,0.06),rgba(10,16,28,0.9))] p-6">
      <p className="text-[11px] uppercase tracking-[0.26em] text-cloud/55">
        Today&apos;s Card
      </p>
      <h1 className="mt-2 font-display text-4xl font-semibold text-cloud sm:text-5xl">
        Play of the Day
      </h1>
      <p className="mt-4 max-w-2xl text-base text-cloud/72">
        {isNoPick
          ? 'No official POTD today. The strongest monitored candidates stayed below the live edge gate.'
          : 'No play posted yet. The worker will publish one card inside the daily window after odds-backed games are available.'}
      </p>

      {schedule ? (
        <div className="mt-8 space-y-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="rounded-2xl border border-white/10 bg-night/40 p-4">
              <div className="text-[11px] uppercase tracking-[0.22em] text-cloud/50">
                Target Post Time
              </div>
              <div className="mt-2 text-lg font-semibold text-cloud">
                {schedule.targetPostTimeEtLabel}
              </div>
            </div>
            <div className="rounded-2xl border border-white/10 bg-night/40 p-4">
              <div className="text-[11px] uppercase tracking-[0.22em] text-cloud/50">
                Earliest Game
              </div>
              <div className="mt-2 text-lg font-semibold text-cloud">
                {schedule.earliestGameTimeEtLabel}
              </div>
            </div>
          </div>
          <p className="text-xs text-cloud/45">Picks post between 12:00 PM– 4:00 PM ET daily</p>
        </div>
      ) : (
        <div className="mt-8 rounded-2xl border border-white/10 bg-night/35 p-4 text-sm text-cloud/62">
          No eligible NHL, NBA, MLB, or NFL games are scheduled for today.
        </div>
      )}
    </section>
  );
}

function renderNominees(nominees: PotdNominee[], winnerStatus: 'FIRED' | 'NO_PICK' | null) {
  if (nominees.length === 0) return null;

  const isNoPick = !winnerStatus || winnerStatus === 'NO_PICK';
  const heading = isNoPick ? 'Monitored Candidates' : 'Nominees';
  const subheading = isNoPick
    ? 'No official POTD today. These did not clear the live edge gate.'
    : 'Other top sport leaders considered today';

  return (
    <section className="rounded-[28px] border border-white/10 bg-surface/80 p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-[11px] uppercase tracking-[0.26em] text-cloud/55">
            {heading}
          </p>
          <p className="mt-1 text-sm text-cloud/50">{subheading}</p>
        </div>
        <span className="rounded-full border border-white/15 bg-white/5 px-3 py-1 text-xs font-semibold tracking-[0.22em] text-cloud/55">
          {nominees.length} play{nominees.length !== 1 ? 's' : ''}
        </span>
      </div>

      <div className="mt-6 space-y-3">
        {nominees.map((nominee) => (
          <article
            key={`${nominee.sport}-${nominee.gameId ?? nominee.rank}-${nominee.marketType ?? ''}`}
            className="rounded-2xl border border-white/10 bg-night/35 p-4"
          >
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <div className="flex items-center gap-2">
                  <span className="rounded-full border border-white/15 bg-white/5 px-2 py-0.5 text-[10px] font-semibold tracking-[0.2em] text-cloud/60">
                    {nominee.sport}
                  </span>
                  {nominee.confidenceLabel && (
                    <span className="text-[10px] uppercase tracking-[0.18em] text-cloud/40">
                      {nominee.confidenceLabel}
                    </span>
                  )}
                </div>
                <div className="mt-2 text-sm font-semibold text-cloud">
                  {nominee.selectionLabel ?? '—'}
                </div>
                <div className="mt-0.5 text-xs text-cloud/55">
                  {nominee.awayTeam} @ {nominee.homeTeam}
                </div>
              </div>
              <div className="text-right">
                <div className="text-lg font-semibold text-cloud">
                  {formatNomineeEdgeLabel(nominee.edgePct)}
                </div>
                <div className="text-[11px] uppercase tracking-[0.18em] text-cloud/40">edge</div>
              </div>
            </div>
            <div className="mt-3 flex flex-wrap gap-4 text-xs text-cloud/50">
              <span>
                Score{' '}
                <span className="font-medium text-cloud/75">
                  {nominee.totalScore !== null ? nominee.totalScore.toFixed(3) : '—'}
                </span>
              </span>
              <span>{nominee.gameTimeEtLabel}</span>
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}

function renderDiagnosticNominees(
  diagnosticNominees: PotdNominee[],
  winnerStatus: 'FIRED' | 'NO_PICK' | null,
) {
  if (winnerStatus !== 'NO_PICK' || diagnosticNominees.length === 0) return null;

  return (
    <details className="rounded-[28px] border border-white/10 bg-surface/70 p-6">
      <summary className="cursor-pointer list-none select-none">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className="text-[11px] uppercase tracking-[0.26em] text-cloud/55">
              Diagnostics
            </p>
            <p className="mt-1 text-sm text-cloud/50">
              No official POTD today. These did not clear the live edge gate.
            </p>
          </div>
          <span className="rounded-full border border-white/15 bg-white/5 px-3 py-1 text-xs font-semibold tracking-[0.22em] text-cloud/55">
            {diagnosticNominees.length} play{diagnosticNominees.length !== 1 ? 's' : ''}
          </span>
        </div>
      </summary>

      <div className="mt-6 space-y-3">
        {diagnosticNominees.map((nominee) => (
          <article
            key={`${nominee.sport}-${nominee.gameId ?? nominee.rank}-${nominee.marketType ?? ''}-diagnostic`}
            className="rounded-2xl border border-white/10 bg-night/35 p-4"
          >
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <div className="flex items-center gap-2">
                  <span className="rounded-full border border-white/15 bg-white/5 px-2 py-0.5 text-[10px] font-semibold tracking-[0.2em] text-cloud/60">
                    {nominee.sport}
                  </span>
                  {nominee.confidenceLabel && (
                    <span className="text-[10px] uppercase tracking-[0.18em] text-cloud/40">
                      {nominee.confidenceLabel}
                    </span>
                  )}
                </div>
                <div className="mt-2 text-sm font-semibold text-cloud">
                  {nominee.selectionLabel ?? '—'}
                </div>
                <div className="mt-0.5 text-xs text-cloud/55">
                  {nominee.awayTeam} @ {nominee.homeTeam}
                </div>
              </div>
              <div className="text-right">
                <div className="text-lg font-semibold text-cloud">
                  {formatNomineeEdgeLabel(nominee.edgePct)}
                </div>
                <div className="text-[11px] uppercase tracking-[0.18em] text-cloud/40">edge</div>
              </div>
            </div>
            <div className="mt-3 flex flex-wrap gap-4 text-xs text-cloud/50">
              <span>
                Score{' '}
                <span className="font-medium text-cloud/75">
                  {nominee.totalScore !== null ? nominee.totalScore.toFixed(3) : '—'}
                </span>
              </span>
              <span>{nominee.gameTimeEtLabel}</span>
            </div>
          </article>
        ))}
      </div>
    </details>
  );
}

function renderNearMissSummary(summary: PotdNearMissSummary) {
  return (
    <section className="rounded-[28px] border border-white/10 bg-surface/80 p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-[11px] uppercase tracking-[0.26em] text-cloud/55">
            Near-Miss Tracking
          </p>
          <p className="mt-1 text-sm text-cloud/50">
            Top non-winning POTD nominees settled with virtual 1u grading.
          </p>
        </div>
        <span className="rounded-full border border-white/15 bg-white/5 px-3 py-1 text-xs font-semibold tracking-[0.22em] text-cloud/55">
          {summary.sampleSize} tracked
        </span>
      </div>

      <div className="mt-5 grid gap-3 sm:grid-cols-5">
        <div className="rounded-2xl border border-white/10 bg-night/40 p-4">
          <div className="text-[11px] uppercase tracking-[0.22em] text-cloud/50">
            Record
          </div>
          <div className="mt-2 text-xl font-semibold text-cloud">
            {summary.wins}-{summary.losses}
            {summary.pushes > 0 ? `-${summary.pushes}` : ''}
          </div>
        </div>
        <div className="rounded-2xl border border-white/10 bg-night/40 p-4">
          <div className="text-[11px] uppercase tracking-[0.22em] text-cloud/50">
            Win Rate
          </div>
          <div className="mt-2 text-xl font-semibold text-cloud">
            {summary.winRate === null ? 'N/A' : formatPercent(summary.winRate)}
          </div>
        </div>
        <a
          href="/play-of-the-day/settled"
          aria-label="Open POTD settled games"
          title="Open settled games"
          className="cursor-pointer rounded-2xl border border-white/10 bg-night/40 p-4 transition hover:border-teal/45 hover:bg-teal/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal/60 focus-visible:ring-offset-2 focus-visible:ring-offset-night"
        >
          <div className="text-[11px] uppercase tracking-[0.22em] text-cloud/50">
            Settled
          </div>
          <div className="mt-2 text-xl font-semibold text-cloud">
            {summary.settledCount}
          </div>
          <div className="mt-1 text-[10px] uppercase tracking-[0.18em] text-teal-100/80">
            View all settled games
          </div>
        </a>
        <a
          href="/play-of-the-day/pending"
          aria-label="Open POTD pending games"
          title="Open pending games"
          className="cursor-pointer rounded-2xl border border-white/10 bg-night/40 p-4 transition hover:border-teal/45 hover:bg-teal/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal/60 focus-visible:ring-offset-2 focus-visible:ring-offset-night"
        >
          <div className="text-[11px] uppercase tracking-[0.22em] text-cloud/50">
            Pending
          </div>
          <div className="mt-2 text-xl font-semibold text-cloud">
            {summary.pending}
          </div>
          <div className="mt-1 text-[10px] uppercase tracking-[0.18em] text-teal-100/80">
            View pending games
          </div>
        </a>
        <div className="rounded-2xl border border-white/10 bg-night/40 p-4">
          <div className="text-[11px] uppercase tracking-[0.22em] text-cloud/50">
            Non-gradeable
          </div>
          <div className="mt-2 text-xl font-semibold text-cloud">
            {summary.nonGradeable}
          </div>
        </div>
      </div>
    </section>
  );
}

export default function PlayOfTheDayClient({
  initialData,
}: PlayOfTheDayClientProps) {
  const {
    featuredPick,
    today,
    history,
    bankroll,
    schedule,
    nominees,
    diagnosticNominees,
    nearMissSummary,
    winnerStatus,
  } = initialData;
  const activePick = featuredPick ?? today;

  return (
    <div className="min-h-screen bg-night px-4 py-8 text-cloud sm:px-6 lg:px-8">
      <StickyBackButton fallbackHref="/" fallbackLabel="Home" />

      <main className="mx-auto flex max-w-6xl flex-col gap-8">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <p className="text-[11px] uppercase tracking-[0.22em] text-cloud/50">
              Daily Selection
            </p>
            <p className="mt-2 text-sm text-cloud/62">
              One worker-published card per day, with bankroll tracking and settlement history.
            </p>
          </div>
          <div className="flex items-center gap-3">
            <Link
              href="/cards"
              className="rounded-full border border-white/15 px-4 py-2 text-sm font-medium text-cloud/80 transition hover:border-white/30 hover:text-cloud"
            >
              View Cards
            </Link>
            <Link
              href="/results"
              className="rounded-full border border-teal/35 bg-teal/10 px-4 py-2 text-sm font-medium text-teal-100 transition hover:border-teal/50 hover:bg-teal/15"
            >
              View Results
            </Link>
          </div>
        </div>

        {activePick ? renderTodayCard(activePick) : renderEmptyState(schedule, winnerStatus)}

        {renderNominees(nominees ?? [], winnerStatus ?? null)}
        {renderDiagnosticNominees(diagnosticNominees ?? [], winnerStatus ?? null)}
        {renderNearMissSummary(
          nearMissSummary ?? {
            sampleSize: 0,
            settledCount: 0,
            wins: 0,
            losses: 0,
            pushes: 0,
            pending: 0,
            nonGradeable: 0,
            winRate: null,
          },
        )}

        <section className="grid gap-4 lg:grid-cols-3">
          {bankrollStat('Current Bankroll', formatCurrency(bankroll.current), metricTone(bankroll.netProfit))}
          {bankrollStat('Net Profit', formatSignedDollars(bankroll.netProfit), metricTone(bankroll.netProfit))}
          {bankrollStat(
            'ROI',
            bankroll.roi === null ? 'N/A' : formatPercent(bankroll.roi),
            metricTone(bankroll.roi),
          )}
        </section>

        <section className="grid gap-4 xl:grid-cols-[minmax(0,1.2fr)_minmax(0,1.8fr)]">
          <div className="rounded-[28px] border border-white/10 bg-surface/80 p-6">
            <div className="flex items-center justify-between gap-3">
              <h2 className="font-display text-2xl font-semibold text-cloud">
                Bankroll
              </h2>
              <span className="text-xs uppercase tracking-[0.22em] text-cloud/45">
                {bankroll.postedCount} posted
              </span>
            </div>

            <div className="mt-6 grid gap-3 sm:grid-cols-2">
              <div className="rounded-2xl border border-white/10 bg-night/40 p-4">
                <div className="text-[11px] uppercase tracking-[0.22em] text-cloud/50">
                  Starting
                </div>
                <div className="mt-2 text-xl font-semibold text-cloud">
                  {formatCurrency(bankroll.starting)}
                </div>
              </div>
              <div className="rounded-2xl border border-white/10 bg-night/40 p-4">
                <div className="text-[11px] uppercase tracking-[0.22em] text-cloud/50">
                  Win Rate
                </div>
                <div className="mt-2 text-xl font-semibold text-cloud">
                  {bankroll.winRate === null ? 'N/A' : formatPercent(bankroll.winRate)}
                </div>
              </div>
            </div>

            <div className="mt-6 rounded-2xl border border-white/10 bg-night/35 p-4">
              <div className="text-[11px] uppercase tracking-[0.22em] text-cloud/50">
                Record
              </div>
              <div className="mt-3 flex flex-wrap gap-2">
                <span className="rounded-full border border-emerald-500/30 bg-emerald-500/10 px-3 py-1 text-xs font-semibold text-emerald-200">
                  {bankroll.wins} WIN
                </span>
                <span className="rounded-full border border-rose-500/30 bg-rose-500/10 px-3 py-1 text-xs font-semibold text-rose-200">
                  {bankroll.losses} LOSS
                </span>
                <span className="rounded-full border border-amber-500/30 bg-amber-500/10 px-3 py-1 text-xs font-semibold text-amber-200">
                  {bankroll.pushes} PUSH
                </span>
              </div>
              <div className="mt-4 text-sm text-cloud/60">
                {bankroll.settledCount} settled results across the published POTD history.
              </div>
            </div>
          </div>

          <div
            id="potd-play-log"
            className="scroll-mt-24 rounded-[28px] border border-white/10 bg-surface/80 p-6"
          >
            <div className="flex items-center justify-between gap-3">
              <h2 className="font-display text-2xl font-semibold text-cloud">
                Recent History
              </h2>
              <span className="text-xs uppercase tracking-[0.22em] text-cloud/45">
                Settled-history view
              </span>
            </div>

            {history.length === 0 ? (
              <div className="mt-6 rounded-2xl border border-dashed border-white/12 bg-night/30 p-6 text-sm text-cloud/62">
                No settled-history rows yet. Once earlier plays settle, they will appear here.
              </div>
            ) : (
              <div className="mt-6 space-y-3">
                {history.map((row) => {
                  const result = formatResultLabel(row.result);

                  return (
                    <article
                      key={row.id}
                      className="rounded-2xl border border-white/10 bg-night/35 p-4"
                    >
                      <div className="flex flex-wrap items-start justify-between gap-3">
                        <div>
                          <div className="text-sm font-semibold text-cloud">
                            {row.selectionLabel}
                          </div>
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

                      <div className="mt-4 grid gap-3 text-sm text-cloud/70 sm:grid-cols-4">
                        <div>
                          <div className="text-[11px] uppercase tracking-[0.18em] text-cloud/45">
                            Game Time
                          </div>
                          <div className="mt-1">{row.gameTimeEtLabel}</div>
                        </div>
                        <div>
                          <div className="text-[11px] uppercase tracking-[0.18em] text-cloud/45">
                            Edge
                          </div>
                          <div className="mt-1">{formatPercent(row.edgePct)}</div>
                        </div>
                        <div>
                          <div className="text-[11px] uppercase tracking-[0.18em] text-cloud/45">
                            Wager
                          </div>
                          <div className="mt-1">{formatCurrency(row.wagerAmount)}</div>
                        </div>
                        <div>
                          <div className="text-[11px] uppercase tracking-[0.18em] text-cloud/45">
                            P&amp;L
                          </div>
                          <div className={`mt-1 font-medium ${metricTone(row.pnlDollars)}`}>
                            {row.pnlDollars === null
                              ? 'Pending'
                              : formatSignedDollars(row.pnlDollars)}
                          </div>
                        </div>
                      </div>
                    </article>
                  );
                })}
              </div>
            )}
          </div>
        </section>
      </main>
    </div>
  );
}
