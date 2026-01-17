import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Disclaimers | Cheddar Logic",
  description: "Educational and compliance disclaimers governing Cheddar Logic's analytical materials.",
};

const PRINCIPLES = [
  {
    title: "Educational intent",
    description:
      "All materials illustrate analytical reasoning techniques. They are not actionable betting advice, investment guidance, or personalized recommendations.",
  },
  {
    title: "User responsibility",
    description:
      "Decisions made after reading Cheddar Logic content remain exclusively yours. We do not track or influence your wagering or financial activity.",
  },
  {
    title: "Abstention-first",
    description:
      "Model outputs include the option to withhold publication. Suppression is documented as a successful adherence to process, not a missed opportunity.",
  },
];

export default function DisclaimerPage() {
  return (
    <article className="space-y-10">
      <section className="space-y-4">
        <h2 className="font-display text-3xl font-semibold text-cloud">Core Disclaimers</h2>
        <p>
          Cheddar Logic LLC is a statistical analysis and decision-support platform. The content provided on this
          site, within our Discord community, or through any downloadable material is strictly intended for
          informational and educational purposes. We do not provide betting tips, guaranteed outcomes, or fiduciary
          services. Examples referencing public markets exist solely to explain model calibration.
        </p>
      </section>

      <section className="grid gap-4 md:grid-cols-3">
        {PRINCIPLES.map((principle) => (
          <article key={principle.title} className="rounded-2xl border border-white/10 bg-surface/70 p-6">
            <p className="text-xs uppercase tracking-[0.3em] text-cloud/60">{principle.title}</p>
            <p className="mt-3 text-sm text-cloud/80">{principle.description}</p>
          </article>
        ))}
      </section>

      <section className="space-y-3">
        <h3 className="font-display text-2xl font-semibold text-cloud">Market References</h3>
        <p>
          Any mention of odds, spreads, totals, or similar market data is used to benchmark internal models
          against widely available public references. We neither encourage nor discourage wagering activity.
          Historical discussions focus on analytical discipline—specifically when we abstained due to widened
          variance or incomplete information.
        </p>
      </section>

      <section className="space-y-3">
        <h3 className="font-display text-2xl font-semibold text-cloud">No Performance Claims</h3>
        <p>
          We do not market win rates, unit counts, ROI, or similar performance language. When diagnostics are
          shown, they focus on calibration error, abstention frequency, or methodological learnings. Past
          analytical outputs do not predict future performance, and suppressing a signal is often the desired
          result.
        </p>
      </section>

      <section className="space-y-3">
        <h3 className="font-display text-2xl font-semibold text-cloud">Third-Party Links</h3>
        <p>
          Links to Discord, Stripe, or other platforms are provided for convenience. Cheddar Logic does not
          control third-party privacy or compliance practices. Review their policies before sharing any
          information.
        </p>
      </section>

      <section className="space-y-3">
        <h3 className="font-display text-2xl font-semibold text-cloud">Regulatory Considerations</h3>
        <p>
          Cheddar Logic operates as an analytics and software organization. We are not registered as a gambling
          service, financial advisor, or broker. Users are responsible for complying with applicable local laws
          regarding wagering, data use, and information sharing.
        </p>
      </section>

      <section className="space-y-3">
        <h3 className="font-display text-2xl font-semibold text-cloud">Contact</h3>
        <p>
          Questions about this disclaimer should be sent to <a className="text-teal" href="mailto:compliance@cheddarlogic.com">compliance@cheddarlogic.com</a>. Please include jurisdiction and the
          specific concern so we can respond accurately.
        </p>
      </section>
    </article>
  );
}
