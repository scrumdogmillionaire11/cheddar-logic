import Link from "next/link";

export default function FPLPage() {
  return (
    <div className="min-h-screen bg-night px-6 py-12 text-cloud">
      <div className="mx-auto max-w-4xl">
        <div className="mb-8">
          <Link href="/" className="text-sm text-cloud/60 hover:text-cloud/80">
            ← Back to Home
          </Link>
        </div>

        <div className="space-y-8">
          <div>
            <h1 className="mb-2 font-display text-4xl font-semibold">FPL Team Check</h1>
            <p className="text-lg text-cloud/70">
              Check your Fantasy Premier League team and get insights
            </p>
          </div>

          <div className="rounded-xl border border-white/10 bg-surface/80 p-8">
            <div className="space-y-6">
              <div>
                <label
                  htmlFor="teamId"
                  className="mb-2 block text-sm font-semibold text-cloud/70"
                >
                  Enter your FPL Team ID
                </label>
                <input
                  type="text"
                  id="teamId"
                  placeholder="e.g., 123456"
                  className="w-full rounded-lg border border-white/20 bg-surface px-4 py-3 text-cloud outline-none transition focus:border-teal"
                />
              </div>

              <button
                type="button"
                className="w-full rounded-lg bg-teal px-6 py-3 font-semibold text-night transition hover:opacity-90"
              >
                Check Team
              </button>
            </div>
          </div>

          <div className="rounded-xl border border-white/10 bg-surface/80 p-8">
            <h2 className="mb-4 text-xl font-semibold">How to find your Team ID</h2>
            <ol className="list-decimal space-y-2 pl-5 text-cloud/70">
              <li>Go to the Fantasy Premier League website</li>
              <li>Navigate to your team page</li>
              <li>Look at the URL - your Team ID is the number after "entry/"</li>
              <li>Example: fantasy.premierleague.com/entry/123456/</li>
            </ol>
          </div>
        </div>
      </div>
    </div>
  );
}
