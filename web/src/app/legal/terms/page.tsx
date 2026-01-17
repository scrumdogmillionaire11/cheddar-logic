import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Terms of Service | Cheddar Logic",
  description: "Understand the usage rules governing Cheddar Logic's analytical materials and community access.",
};

const PROHIBITED_USES = [
  "Reselling or packaging Cheddar Logic materials as betting advice.",
  "Automated scraping or extraction of gated content without written consent.",
  "Attempting to reverse engineer models provided in read-only form.",
  "Using the community to coordinate wagering or solicit financial backing.",
];

const SERVICE_COMMITMENTS = [
  "Provide educational analytical materials emphasizing probabilistic reasoning.",
  "Maintain infrastructure with commercially reasonable uptime (target 99%).",
  "Deliver accurate compliance disclaimers and public methodology documentation.",
  "Respond to support inquiries within two business days.",
];

export default function TermsPage() {
  return (
    <article className="space-y-10">
      <section className="space-y-4">
        <h2 className="font-display text-3xl font-semibold text-cloud">Agreement Overview</h2>
        <p>
          By accessing Cheddar Logic properties, you agree to these Terms of Service. If you represent an
          organization, you warrant you have authority to bind the organization. We may update these terms at any
          time. Continued use after updates constitutes acceptance of the revised terms.
        </p>
      </section>

      <section className="space-y-3">
        <h3 className="font-display text-2xl font-semibold text-cloud">Nature of Service</h3>
        <p>
          Cheddar Logic delivers analytical education and methodological transparency. We do not offer betting
          advice, individualized recommendations, or guaranteed outcomes. Any reference to markets is for
          research comparison only. Users remain solely responsible for their own decisions.
        </p>
      </section>

      <section className="space-y-3">
        <h3 className="font-display text-2xl font-semibold text-cloud">Account & Community Conduct</h3>
        <p>
          Community access (e.g., Discord) requires adherence to our Code of Conduct: epistemic humility, respect
          for other researchers, and prohibition of promotional content. We may revoke access at our discretion
          if behavior undermines analytical quality or violates law.
        </p>
      </section>

      <section className="space-y-3">
        <h3 className="font-display text-2xl font-semibold text-cloud">Prohibited Uses</h3>
        <ul className="list-disc space-y-2 pl-6 text-cloud/80">
          {PROHIBITED_USES.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
      </section>

      <section className="space-y-3">
        <h3 className="font-display text-2xl font-semibold text-cloud">Subscriptions & Payments</h3>
        <p>
          When subscription tiers launch, Stripe will act as the merchant of record. Fees are charged in advance
          on a recurring basis until canceled. We do not store card numbers. Users may cancel any time; access
          continues until the end of the paid period. Refunds are handled case-by-case if we fail to deliver the
          described educational service.
        </p>
      </section>

      <section className="space-y-3">
        <h3 className="font-display text-2xl font-semibold text-cloud">Service Commitments</h3>
        <ul className="list-disc space-y-2 pl-6 text-cloud/80">
          {SERVICE_COMMITMENTS.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
      </section>

      <section className="space-y-3">
        <h3 className="font-display text-2xl font-semibold text-cloud">Disclaimer of Warranties</h3>
        <p>
          CHEEDAR LOGIC PROVIDES ALL MATERIALS &quot;AS IS&quot; WITHOUT WARRANTIES OF ANY KIND, EXPRESS OR IMPLIED. WE
          DISCLAIM WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE, AND NON-INFRINGEMENT. ANALYTICAL
          OUTPUTS MAY CONTAIN ERRORS OR INCOMPLETE INFORMATION. YOU USE ALL MATERIALS AT YOUR OWN RISK.
        </p>
      </section>

      <section className="space-y-3">
        <h3 className="font-display text-2xl font-semibold text-cloud">Limitation of Liability</h3>
        <p>
          To the maximum extent permitted by law, Cheddar Logic LLC and its officers shall not be liable for any
          indirect, incidental, consequential, or punitive damages arising from the use or inability to use our
          services. Total direct damages, if any, are limited to the fees paid for the affected service during the
          twelve months preceding the claim.
        </p>
      </section>

      <section className="space-y-3">
        <h3 className="font-display text-2xl font-semibold text-cloud">Governing Law & Dispute Resolution</h3>
        <p>
          These terms are governed by the laws of the State of Delaware, USA, without regard to conflict of law
          principles. Disputes must first attempt informal resolution by emailing legal@cheddarlogic.com. If no
          resolution occurs within 30 days, parties agree to binding arbitration in Wilmington, Delaware.
        </p>
      </section>
    </article>
  );
}
