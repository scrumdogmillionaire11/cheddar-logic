type Pillar = {
  title: string;
  description: string;
  bullets: string[];
};

type Diagnostic = {
  label: string;
  value: string;
  caption: string;
};

type MethodologyShowcaseProps = {
  pillars: Pillar[];
  diagnostics: Diagnostic[];
  disclaimer: string;
};

export function MethodologyShowcase({
  pillars,
  diagnostics,
  disclaimer,
}: MethodologyShowcaseProps) {
  return (
    <section className="space-y-10">
      <div className="space-y-4">
        <p className="text-sm font-semibold uppercase tracking-[0.3em] text-cloud/70">
          No play is a play
        </p>
        <h2 className="font-display text-3xl font-semibold text-cloud sm:text-4xl">
          Process transparency leads the conversation
        </h2>
        <p className="max-w-3xl text-base text-cloud/80">
          Every surface prioritizes calibration, variance, and the rationale for suppressing output when
          confidence bands widen. Users learn how to interrogate a model rather than follow it.
        </p>
      </div>
      <div className="grid gap-6 lg:grid-cols-[1.4fr_0.6fr]">
        <div className="space-y-4">
          {pillars.map((pillar) => (
            <details
              key={pillar.title}
              className="rounded-2xl border border-white/10 bg-surface/80 p-6 shadow-panel"
              open
            >
              <summary className="cursor-pointer list-none">
                <div className="flex items-center justify-between gap-4">
                  <div>
                    <p className="text-sm font-semibold text-cloud/70">{pillar.title}</p>
                    <p className="mt-1 text-base text-cloud/80">{pillar.description}</p>
                  </div>
                  <span className="text-sm text-cloud/60">View logic</span>
                </div>
              </summary>
              <ul className="mt-4 space-y-2 text-sm text-cloud/75">
                {pillar.bullets.map((bullet) => (
                  <li key={bullet} className="flex gap-2">
                    <span className="text-teal">▹</span>
                    <span>{bullet}</span>
                  </li>
                ))}
              </ul>
            </details>
          ))}
        </div>
        <div className="grid gap-4">
          {diagnostics.map((diagnostic) => (
            <article
              key={diagnostic.label}
              className="rounded-2xl border border-white/10 bg-surface-muted/80 p-6"
            >
              <p className="text-xs uppercase tracking-[0.3em] text-cloud/50">
                {diagnostic.label}
              </p>
              <p className="mt-3 font-display text-4xl font-semibold text-cloud">
                {diagnostic.value}
              </p>
              <p className="mt-1 text-sm text-cloud/70">{diagnostic.caption}</p>
            </article>
          ))}
          <p className="rounded-2xl border border-white/10 bg-night/60 p-5 text-xs uppercase tracking-[0.25em] text-cloud/70">
            {disclaimer}
          </p>
        </div>
      </div>
    </section>
  );
}
