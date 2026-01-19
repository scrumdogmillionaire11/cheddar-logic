import Link from "next/link";

export default function Home() {
  const discordInvite =
    process.env.NEXT_PUBLIC_DISCORD_INVITE ?? "https://discord.com/invite/cheddarlogic";

  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-night px-6 text-cloud">
      <main className="w-full max-w-2xl space-y-12 text-center">
        <div className="space-y-4">
          <h1 className="font-display text-5xl font-semibold text-cloud sm:text-6xl">
            Cheddar Logic
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
            FPL Team Check
          </Link>

          <Link
            href="/education"
            className="rounded-xl border border-white/20 bg-surface/80 px-8 py-6 text-lg font-semibold transition hover:border-white/40 hover:bg-surface"
          >
            Educational Materials
          </Link>

          <a
            href={discordInvite}
            target="_blank"
            rel="noreferrer noopener"
            className="rounded-xl border border-white/20 bg-surface/80 px-8 py-6 text-lg font-semibold transition hover:border-white/40 hover:bg-surface"
          >
            Join Discord
          </a>

          <Link
            href="/admin"
            className="rounded-xl border border-white/20 bg-surface/80 px-8 py-6 text-lg font-semibold transition hover:border-white/40 hover:bg-surface"
          >
            Admin
          </Link>
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
