import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Legal | Cheddar Logic',
  description:
    'Policies, disclaimers, and compliance statements for Cheddar Logic LLC.',
};

export default function LegalLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="bg-night text-cloud">
      <main className="mx-auto flex max-w-5xl flex-col gap-10 px-6 py-16 sm:px-8 lg:px-0">
        <header className="space-y-3 text-center">
          <p className="text-sm font-semibold uppercase tracking-[0.3em] text-cloud/70">
            Compliance & Legal
          </p>
          <h1 className="font-display text-4xl font-semibold">
            Responsible analytical operations
          </h1>
          <p className="text-base text-cloud/80">
            Cheddar Logic LLC builds abstention-first decision-support tooling.
            All materials on this site are informational and educational. Review
            the governing documents below before engaging with our community or
            services.
          </p>
        </header>
        {children}
      </main>
    </div>
  );
}
