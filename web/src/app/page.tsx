import type { Metadata } from 'next';
import Link from 'next/link';
import { closeDatabaseReadOnly } from '@cheddar-logic/data';
import { getPotdResponseData } from '@/lib/potd-server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Cheddar Logic | Signal-Qualified Analytics',
  description:
    'Signal-qualified analytical outputs built on confidence thresholds and uncertainty controls.',
  openGraph: {
    title: 'Cheddar Logic | Signal-Qualified Analytics',
    description:
      'Signal-qualified analytical outputs built on confidence thresholds and uncertainty controls.',
    url: 'https://cheddarlogic.com',
  },
};

export default async function Home() {
  let hasPresentedPotd = false;
  try {
    const potdData = await getPotdResponseData();
    hasPresentedPotd = Boolean(potdData.featuredPick ?? potdData.today);
  } catch (error) {
    console.warn('[home] failed to resolve POTD nav state', error);
  } finally {
    try {
      closeDatabaseReadOnly();
    } catch (error) {
      console.warn('[home] closeDatabaseReadOnly failed during page teardown', error);
    }
  }

  const discordInvite =
    process.env.NEXT_PUBLIC_DISCORD_INVITE ??
    'https://discord.com/invite/cheddarlogic';
  const navCardClass =
    'rounded-xl border border-white/20 bg-surface/80 px-8 py-6 text-lg font-semibold transition hover:border-white/40 hover:bg-surface';
  const livePotdCardClass =
    'rounded-xl border border-emerald-400/60 bg-emerald-500/15 px-8 py-6 text-lg font-semibold text-emerald-50 shadow-[0_0_32px_rgba(34,197,94,0.18)] transition hover:border-emerald-300/80 hover:bg-emerald-500/20';

  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-night px-6 text-cloud">
      <main className="w-full max-w-2xl space-y-12 text-center">
        <div className="space-y-4">
          <h1 className="font-display text-5xl font-semibold text-cloud sm:text-6xl">
            cheddar logic
          </h1>
          <p className="text-lg text-cloud/80">
            Probabilistic sports analytics and insights
          </p>
        </div>

        <nav className="mx-auto grid max-w-md gap-4">
          <Link
            href="/fpl"
            className={navCardClass}
          >
            🧙‍♂️ FPL SAGE 🧙‍♂️
          </Link>

          <Link
            href="/wedge"
            className={navCardClass}
          >
            🧀 The Wedge 🧀
          </Link>

          <Link
            href="/play-of-the-day"
            className={hasPresentedPotd ? livePotdCardClass : navCardClass}
          >
            🎯 Play of the Day 🎯
          </Link>

          <Link
            href="/results"
            className={navCardClass}
          >
            📊 Results 📊
          </Link>

          <Link
            href="/market-pulse"
            className={navCardClass}
          >
            📡 Market Pulse 📡
          </Link>

          <Link
            href="/education"
            className={navCardClass}
          >
            📓 Educational Materials 📓
          </Link>

          <a
            href={discordInvite}
            target="_blank"
            rel="noreferrer noopener"
            className={navCardClass}
          >
            👾 Join Discord 👾
          </a>

          {process.env.NODE_ENV === 'development' && (
            <Link
              href="/admin"
              className={navCardClass}
            >
              🏥 Model Health 🏥
            </Link>
          )}
        </nav>

        <footer className="pt-8 text-xs text-cloud/60">
          <div className="space-x-4">
            <Link href="/legal/privacy" className="hover:text-cloud/80">
              Privacy
            </Link>
            <Link href="/legal/terms" className="hover:text-cloud/80">
              Terms
            </Link>
            <Link href="/legal/disclaimer" className="hover:text-cloud/80">
              Disclaimer
            </Link>
          </div>
        </footer>
      </main>
    </div>
  );
}
