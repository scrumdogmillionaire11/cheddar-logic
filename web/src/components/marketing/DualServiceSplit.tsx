type Service = {
  title: string;
  focus: string;
  ratio: string;
  bullets: string[];
};

type DualServiceSplitProps = {
  analytics: Service;
  customDev: Service;
};

export function DualServiceSplit({ analytics, customDev }: DualServiceSplitProps) {
  const cards = [analytics, customDev];

  return (
    <section className="space-y-8">
      <div className="flex flex-col gap-3">
        <p className="text-sm font-semibold uppercase tracking-[0.3em] text-cloud/70">
          Dual business model
        </p>
        <h2 className="font-display text-3xl font-semibold text-cloud">
          80% analytical infrastructure, 20% bespoke delivery
        </h2>
      </div>
      <div className="grid gap-6 md:grid-cols-2">
        {cards.map((card) => (
          <article
            key={card.title}
            className="rounded-3xl border border-white/10 bg-surface/80 p-8 shadow-panel"
          >
            <div className="flex items-center justify-between text-sm text-cloud/70">
              <span>{card.focus}</span>
              <span className="font-semibold text-teal">{card.ratio}</span>
            </div>
            <h3 className="mt-4 font-display text-2xl font-semibold text-cloud">
              {card.title}
            </h3>
            <ul className="mt-6 space-y-3 text-sm text-cloud/75">
              {card.bullets.map((bullet) => (
                <li key={bullet} className="flex gap-3">
                  <span className="mt-1 h-2 w-2 rounded-full bg-amber"></span>
                  <span>{bullet}</span>
                </li>
              ))}
            </ul>
          </article>
        ))}
      </div>
    </section>
  );
}
