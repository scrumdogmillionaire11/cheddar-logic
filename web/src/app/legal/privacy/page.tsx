import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Privacy Policy | Cheddar Logic",
  description: "Learn how Cheddar Logic collects, stores, and protects limited user information.",
};

const DATA_RETENTION_DAYS = 90;

const processors = [
  {
    name: "Vercel",
    purpose: "Hosting and performance monitoring for the landing page.",
    data: "Request logs, deployment metadata (no visitor profiling).",
  },
  {
    name: "Discord",
    purpose: "Community access and role management upon user consent.",
    data: "Discord username, member status.",
  },
  {
    name: "Stripe",
    purpose: "Payment processing for future subscription tiers (no card data stored by Cheddar Logic).",
    data: "Billing contact info, subscription status.",
  },
];

export default function PrivacyPolicyPage() {
  return (
    <article className="space-y-10">
      <section className="space-y-4">
        <h2 className="font-display text-3xl font-semibold text-cloud">Privacy Overview</h2>
        <p>
          Cheddar Logic LLC collects the minimum amount of personal information required to operate an
          educational analytics platform. We never buy, sell, or broker user data. All processing activities are
          grounded in legitimate interest for site reliability, contractual necessity for subscriptions, or user
          consent for community participation.
        </p>
      </section>

      <section className="space-y-3">
        <h3 className="font-display text-2xl font-semibold text-cloud">Information We Collect</h3>
        <ul className="list-disc space-y-2 pl-6 text-cloud/80">
          <li>
            <strong className="text-cloud">Contact submissions:</strong> name, email, inquiry details, retained for up to {DATA_RETENTION_DAYS} days.
          </li>
          <li>
            <strong className="text-cloud">Community access:</strong> Discord username and roles when you opt into the research server.
          </li>
          <li>
            <strong className="text-cloud">Subscription records:</strong> billing contact data managed by Stripe when subscriptions launch.
          </li>
          <li>
            <strong className="text-cloud">Analytics:</strong> aggregated page performance metrics (no behavioral profiling, no third-party ads).
          </li>
        </ul>
      </section>

      <section className="space-y-3">
        <h3 className="font-display text-2xl font-semibold text-cloud">How We Use Your Information</h3>
        <p>We apply strict purpose limitation:</p>
        <ul className="list-disc space-y-2 pl-6 text-cloud/80">
          <li>Respond to support and partnership inquiries.</li>
          <li>Grant or revoke Discord community access aligned with our Code of Conduct.</li>
          <li>Process subscription payments and deliver receipts via Stripe.</li>
          <li>Monitor infrastructure health, fraud, and abuse without tracking betting behavior.</li>
        </ul>
      </section>

      <section className="space-y-3">
        <h3 className="font-display text-2xl font-semibold text-cloud">Processors & Subprocessors</h3>
        <div className="overflow-hidden rounded-2xl border border-white/10">
          <table className="w-full text-sm text-cloud/80">
            <thead className="bg-surface-muted/80 text-left text-cloud/70">
              <tr>
                <th className="px-4 py-3 font-semibold">Processor</th>
                <th className="px-4 py-3 font-semibold">Purpose</th>
                <th className="px-4 py-3 font-semibold">Data</th>
              </tr>
            </thead>
            <tbody>
              {processors.map((processor) => (
                <tr key={processor.name} className="border-t border-white/5">
                  <td className="px-4 py-3 text-cloud">{processor.name}</td>
                  <td className="px-4 py-3">{processor.purpose}</td>
                  <td className="px-4 py-3">{processor.data}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="space-y-3">
        <h3 className="font-display text-2xl font-semibold text-cloud">Your Rights</h3>
        <p>Depending on jurisdiction, you may request:</p>
        <ul className="list-disc space-y-2 pl-6 text-cloud/80">
          <li>Access to the information we hold about you.</li>
          <li>Correction or deletion of inaccurate data.</li>
          <li>Restriction of processing or objection to specific uses.</li>
          <li>Export of data provided to us.</li>
        </ul>
        <p>
          Submit privacy requests to <a className="text-teal" href="mailto:privacy@cheddarlogic.com">privacy@cheddarlogic.com</a>. We respond within 30 days unless law requires faster turnaround.
        </p>
      </section>

      <section className="space-y-3">
        <h3 className="font-display text-2xl font-semibold text-cloud">Data Security & Retention</h3>
        <p>
          We store data in encrypted systems with role-based access controls. Contact form entries auto-delete
          after {DATA_RETENTION_DAYS} days unless a support investigation requires extended retention. Subscription and billing records are held per tax and accounting obligations, typically seven years.
        </p>
      </section>

      <section className="space-y-3">
        <h3 className="font-display text-2xl font-semibold text-cloud">Changes</h3>
        <p>
          We will update this policy whenever our processing changes. The latest version is always available on
          this page with a revised date stamp. Material updates trigger a notice via email or in-product banner.
        </p>
      </section>
    </article>
  );
}
