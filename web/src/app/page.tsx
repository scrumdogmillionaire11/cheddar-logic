import type { Metadata } from 'next';
import Link from 'next/link';

// Revalidate homepage every 5 minutes to prevent stale HTML with old chunk references
export const revalidate = 300;

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

export default function Home() {
  const discordInvite =
    process.env.NEXT_PUBLIC_DISCORD_INVITE ??
    'https://discord.com/invite/cheddarlogic';

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
            className="rounded-xl border border-white/20 bg-surface/80 px-8 py-6 text-lg font-semibold transition hover:border-white/40 hover:bg-surface"
          >
            🧙‍♂️ FPL SAGE 🧙‍♂️
          </Link>

          <Link
            href="/cards"
            className="rounded-xl border border-white/20 bg-surface/80 px-8 py-6 text-lg font-semibold transition hover:border-white/40 hover:bg-surface"
          >
            🧀 The Cheddar Board 🧀
          </Link>

          <Link
            href="/play-of-the-day"
            className="rounded-xl border border-teal/30 bg-teal/10 px-8 py-6 text-lg font-semibold text-teal-100 transition hover:border-teal/50 hover:bg-teal/15"
          >
            🎯 Play of the Day 🎯
          </Link>

          <Link
            href="/results"
            className="rounded-xl border border-white/20 bg-surface/80 px-8 py-6 text-lg font-semibold transition hover:border-white/40 hover:bg-surface"
          >
            📊 Results 📊
          </Link>

          <Link
            href="/education"
            className="rounded-xl border border-white/20 bg-surface/80 px-8 py-6 text-lg font-semibold transition hover:border-white/40 hover:bg-surface"
          >
            📓 Educational Materials 📓
          </Link>

          <a
            href={discordInvite}
            target="_blank"
            rel="noreferrer noopener"
            className="rounded-xl border border-white/20 bg-surface/80 px-8 py-6 text-lg font-semibold transition hover:border-white/40 hover:bg-surface"
          >
            👾 Join Discord 👾
          </a>

          {process.env.NODE_ENV === 'development' && (
            <Link
              href="/admin"
              className="rounded-xl border border-white/20 bg-surface/80 px-8 py-6 text-lg font-semibold transition hover:border-white/40 hover:bg-surface"
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
