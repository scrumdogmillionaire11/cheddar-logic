import type { Metadata } from 'next';
import Link from 'next/link';
import { EDUCATION_ARTICLES } from '@/lib/education/content';

export const metadata: Metadata = {
  title: 'Education | Cheddar Logic',
  description:
    'Guides and frameworks for probabilistic thinking and signal-qualified betting.',
  openGraph: {
    title: 'Education | Cheddar Logic',
    description:
      'Guides and frameworks for probabilistic thinking and signal-qualified betting.',
    url: 'https://cheddarlogic.com/education',
  },
};

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
            <h1 className="mb-2 font-display text-4xl font-semibold">
              Educational Materials
            </h1>
            <p className="text-lg text-cloud/70">
              Learn about probabilistic analytics and FPL strategy
            </p>
          </div>

          <div className="grid gap-6">
            {EDUCATION_ARTICLES.map((article) => (
              <article
                key={article.slug}
                className="rounded-xl border border-white/10 bg-surface/80 p-6 transition hover:border-white/20"
              >
                <h2 className="mb-3 text-xl font-semibold">{article.title}</h2>
                <p className="mb-4 text-cloud/70">{article.summary}</p>
                <Link
                  href={`/education/${article.slug}`}
                  className="text-sm font-semibold text-teal hover:underline"
                >
                  Read More →
                </Link>
              </article>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
