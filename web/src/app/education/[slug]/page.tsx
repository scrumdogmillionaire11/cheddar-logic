import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import {
  EDUCATION_ARTICLES,
  getEducationArticleBySlug,
} from '@/lib/education/content';

type EducationArticlePageProps = {
  params: Promise<{ slug: string }>;
};

export async function generateMetadata({
  params,
}: EducationArticlePageProps): Promise<Metadata> {
  const { slug } = await params;
  const article = getEducationArticleBySlug(slug);
  if (!article) return {};
  return {
    title: `${article.title} | Cheddar Logic`,
    description:
      article.summary ?? `${article.title} — Cheddar Logic educational content.`,
    openGraph: {
      title: article.title,
      description:
        article.summary ??
        `${article.title} — Cheddar Logic educational content.`,
      url: `https://cheddarlogic.com/education/${slug}`,
    },
  };
}

export async function generateStaticParams() {
  return EDUCATION_ARTICLES.map((article) => ({ slug: article.slug }));
}

export default async function EducationArticlePage({
  params,
}: EducationArticlePageProps) {
  const { slug } = await params;
  const article = getEducationArticleBySlug(slug);

  if (!article) {
    notFound();
  }

  return (
    <div className="min-h-screen bg-night px-6 py-12 text-cloud">
      <div className="mx-auto max-w-4xl">
        <div className="mb-8">
          <Link
            href="/education"
            className="text-sm text-cloud/60 hover:text-cloud/80"
          >
            ← Back to Education
          </Link>
        </div>

        <article className="space-y-8 rounded-xl border border-white/10 bg-surface/80 p-8">
          <header className="space-y-4">
            <h1 className="font-display text-4xl font-semibold">
              {article.title}
            </h1>
            <p className="text-lg text-cloud/75">{article.intro}</p>
          </header>

          {article.sections && article.sections.length > 0 ? (
            article.sections.map((section) => (
              <section
                key={`${article.slug}-${section.title}`}
                className="space-y-4"
              >
                <h2 className="text-xl font-semibold">{section.title}</h2>

                {section.paragraphs?.map((paragraph) => (
                  <p
                    key={`${section.title}-${paragraph}`}
                    className="text-cloud/80"
                  >
                    {paragraph}
                  </p>
                ))}

                {section.callout ? (
                  <blockquote className="border-l-2 border-teal/60 pl-4 text-cloud/85 italic">
                    {section.callout}
                  </blockquote>
                ) : null}

                {section.bullets && section.bullets.length > 0 ? (
                  <ul className="space-y-2 text-cloud/80">
                    {section.bullets.map((bullet) => (
                      <li
                        key={`${section.title}-${bullet}`}
                        className="list-inside list-disc"
                      >
                        {bullet}
                      </li>
                    ))}
                  </ul>
                ) : null}
              </section>
            ))
          ) : article.points && article.points.length > 0 ? (
            <section>
              <h2 className="mb-4 text-xl font-semibold">Key Ideas</h2>
              <ul className="space-y-3 text-cloud/80">
                {article.points.map((point) => (
                  <li key={point} className="list-inside list-disc">
                    {point}
                  </li>
                ))}
              </ul>
            </section>
          ) : null}

          {article.takeaways && article.takeaways.length > 0 ? (
            <section>
              <h2 className="mb-4 text-xl font-semibold">
                {article.takeawaysTitle ?? 'Takeaways'}
              </h2>
              <ol className="space-y-2 text-cloud/80">
                {article.takeaways.map((takeaway) => (
                  <li
                    key={`${article.slug}-takeaway-${takeaway}`}
                    className="list-inside list-decimal"
                  >
                    {takeaway}
                  </li>
                ))}
              </ol>
            </section>
          ) : null}

          {article.outro ? (
            <p className="text-cloud/80">{article.outro}</p>
          ) : null}

          {article.resources.length > 0 ? (
            <section>
              <h2 className="mb-4 text-xl font-semibold">Educational Links</h2>
              <div className="grid gap-3">
                {article.resources.map((resource) => {
                  const isExternal =
                    resource.external || resource.href.startsWith('http');
                  const key = `${article.slug}-${resource.href}-${resource.label}`;
                  const className =
                    'rounded-lg border border-white/10 bg-night/20 px-4 py-3 text-teal transition hover:border-white/20';

                  if (isExternal) {
                    return (
                      <a
                        key={key}
                        href={resource.href}
                        target="_blank"
                        rel="noreferrer noopener"
                        className={className}
                      >
                        {resource.label} ↗
                      </a>
                    );
                  }

                  return (
                    <Link key={key} href={resource.href} className={className}>
                      {resource.label}
                    </Link>
                  );
                })}
              </div>
            </section>
          ) : null}
        </article>
      </div>
    </div>
  );
}
