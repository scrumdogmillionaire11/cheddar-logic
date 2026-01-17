type Highlight = {
  label: string;
  value: string;
  detail: string;
};

type HeroPanelProps = {
  title: string;
  subtitle: string;
  highlights: Highlight[];
  discordInvite: string;
  communitySize: string;
};

export function HeroPanel({
  title,
  subtitle,
  highlights,
  discordInvite,
  communitySize,
}: HeroPanelProps) {
  return (
    <section className="grid gap-10 rounded-[2rem] border border-white/5 bg-surface/80 p-10 shadow-panel backdrop-blur-lg lg:grid-cols-[1.2fr_0.8fr]">
      <div className="space-y-6">
        <p className="text-sm font-semibold uppercase tracking-[0.3em] text-cloud/70">
          Abstention-first analytics
        </p>
        <h1 className="text-balance font-display text-4xl font-semibold leading-tight text-cloud sm:text-5xl">
          {title}
        </h1>
        <p className="max-w-2xl text-lg text-cloud/80">{subtitle}</p>
        <div className="flex flex-wrap gap-3 text-sm text-cloud/70">
          <span className="rounded-full border border-white/10 px-4 py-1">
            Community size: {communitySize}
          </span>
          <span className="rounded-full border border-white/10 px-4 py-1">
            Discord only MVP
          </span>
          <span className="rounded-full border border-white/10 px-4 py-1">
            Compliance-first language
          </span>
        </div>
        <div className="flex flex-col gap-4 sm:flex-row">
          <a
            href={discordInvite}
            target="_blank"
            rel="noreferrer noopener"
            className="inline-flex items-center justify-center rounded-full bg-teal px-6 py-3 text-base font-semibold text-night transition hover:opacity-90"
          >
            Join the research workshop
          </a>
          <button
            type="button"
            className="inline-flex items-center justify-center rounded-full border border-white/20 px-6 py-3 text-base font-semibold text-cloud/80 transition hover:border-white/40"
          >
            Download methodology brief
          </button>
        </div>
        <p className="text-xs uppercase tracking-[0.4em] text-cloud/60">
          For informational and educational purposes only
        </p>
      </div>
      <div className="grid gap-4">
        {highlights.map((highlight) => (
          <article
            key={highlight.label}
            className="grid gap-2 rounded-2xl border border-white/10 bg-surface-muted/80 p-6 text-left"
          >
            <p className="text-xs font-semibold uppercase tracking-[0.3em] text-cloud/60">
              {highlight.label}
            </p>
            <p className="font-display text-4xl font-semibold text-cloud">
              {highlight.value}
            </p>
            <p className="text-sm text-cloud/70">{highlight.detail}</p>
          </article>
        ))}
      </div>
    </section>
  );
}
