import Link from "next/link";

export default function EducationPage() {
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
            <h1 className="mb-2 font-display text-4xl font-semibold">Educational Materials</h1>
            <p className="text-lg text-cloud/70">
              Learn about probabilistic analytics and FPL strategy
            </p>
          </div>

          <div className="grid gap-6">
            <article className="rounded-xl border border-white/10 bg-surface/80 p-6 transition hover:border-white/20">
              <h2 className="mb-3 text-xl font-semibold">Getting Started with FPL Analytics</h2>
              <p className="mb-4 text-cloud/70">
                Understanding the basics of Fantasy Premier League analytics and how to use data to
                inform your decisions.
              </p>
              <button className="text-sm font-semibold text-teal hover:underline">
                Read More →
              </button>
            </article>

            <article className="rounded-xl border border-white/10 bg-surface/80 p-6 transition hover:border-white/20">
              <h2 className="mb-3 text-xl font-semibold">Probabilistic Thinking in Sports</h2>
              <p className="mb-4 text-cloud/70">
                Learn how to think in probabilities rather than certainties when analyzing sports
                and making predictions.
              </p>
              <button className="text-sm font-semibold text-teal hover:underline">
                Read More →
              </button>
            </article>

            <article className="rounded-xl border border-white/10 bg-surface/80 p-6 transition hover:border-white/20">
              <h2 className="mb-3 text-xl font-semibold">Understanding Expected Value</h2>
              <p className="mb-4 text-cloud/70">
                A deep dive into expected value calculations and how they apply to FPL team
                selection and transfers.
              </p>
              <button className="text-sm font-semibold text-teal hover:underline">
                Read More →
              </button>
            </article>

            <article className="rounded-xl border border-white/10 bg-surface/80 p-6 transition hover:border-white/20">
              <h2 className="mb-3 text-xl font-semibold">Data Sources and Methodology</h2>
              <p className="mb-4 text-cloud/70">
                Learn about the data sources we use and the methodology behind our analytical
                approach.
              </p>
              <button className="text-sm font-semibold text-teal hover:underline">
                Read More →
              </button>
            </article>
          </div>

          <div className="rounded-xl border border-white/10 bg-surface/80 p-8">
            <h2 className="mb-4 text-xl font-semibold">Video Tutorials</h2>
            <p className="text-cloud/70">Coming soon - video content explaining key concepts</p>
          </div>
        </div>
      </div>
    </div>
  );
}
