import {
  ComplianceFooter,
  ContactCard,
  DiscordCTA,
  DualServiceSplit,
  HeroPanel,
  KillSwitchBanner,
  MethodologyShowcase,
} from "@/components/marketing";
import { getAnalyticsStatus } from "@/lib/config";

const HERO_HIGHLIGHTS = [
  {
    label: "Signal withhold rate",
    value: "42%",
    detail: "Signals withheld when variance breaches guardrails during model run 241.",
  },
  {
    label: "Calibration delta",
    value: "±3.4%",
    detail: "Internal probability vs market reference spread snapshot 2h pre-event.",
  },
  {
    label: "Disclosure set",
    value: "7 assumptions",
    detail: "Each release ships with blockers, data lineage, and audit notes.",
  },
];

const METHODOLOGY_PILLARS = [
  {
    title: "Confidence-gated outputs",
    description: "If uncertainty widens, output halts before it misleads.",
    bullets: [
      "Confidence tiers derived from calibration error not opinion",
      "Suppression published with rationale, blocker, and review cadence",
      "Discord debates center on disagreement artifacts, not picks",
    ],
  },
  {
    title: "Market-relative context",
    description: "Internal projections are always paired with public references.",
    bullets: [
      "No delta is shown without timestamp + market snapshot",
      "Variance tags make drift obvious before anyone overreacts",
      "Outputs are labeled as decision-support, never directives",
    ],
  },
  {
    title: "Transparent diagnostics",
    description: "Every visualization is a teaching moment, not a hype reel.",
    bullets: [
      "Historical error ranges shown beside every projection",
      "Kill switch disables analytics instantly without redeploy",
      "Educational copy explains limitations before value props",
    ],
  },
];

const DIAGNOSTICS = [
  {
    label: "Model run",
    value: "241b",
    caption: "Updated Jan 16 · Snapshot-based, never real-time claims",
  },
  {
    label: "Confidence threshold",
    value: "65th percentile",
    caption: "Threshold at which signals pause until review completes",
  },
  {
    label: "Variance horizon",
    value: "6 hrs",
    caption: "Maximum age of public reference data before refresh",
  },
];

const ANALYTICS_SERVICE = {
  title: "Probabilistic decision-support",
  focus: "Sports analytics infrastructure",
  ratio: "80% focus",
  bullets: [
    "Discord-based MVP with publish-ready methodology",
    "Calibration clinics and signal discipline reviews",
    "Future web portal with the same compliance tone",
  ],
};

const CUSTOM_DEV_SERVICE = {
  title: "Custom web development",
  focus: "High-integrity build partners",
  ratio: "20% focus",
  bullets: [
    "Analytics-adjacent dashboards and internal tooling",
    "Backend services for data integrity + audit trails",
    "Engagements scoped with the same compliance guardrails",
  ],
};

const LEGAL_LINKS = [
  { label: "Privacy", href: "/legal/privacy" },
  { label: "Terms", href: "/legal/terms" },
  { label: "Disclaimers", href: "/legal/disclaimer" },
];

export default function Home() {
  const analyticsStatus = getAnalyticsStatus();
  const discordInvite =
    process.env.NEXT_PUBLIC_DISCORD_INVITE ?? "https://discord.com/invite/cheddarlogic";
  const communitySize = process.env.NEXT_PUBLIC_DISCORD_MEMBER_COUNT ?? "400+ analysts";

  return (
    <div className="bg-night text-cloud">
      <main className="mx-auto flex max-w-6xl flex-col gap-16 px-6 py-12 sm:px-8 lg:px-12">
        <KillSwitchBanner status={analyticsStatus} />
        <HeroPanel
          title="We publish probabilistic guardrails so you can reason, not react"
          subtitle="Probabilistic sports analytics that surface signals only when confidence, context, and data alignment justify them."
          highlights={HERO_HIGHLIGHTS}
          discordInvite={discordInvite}
          communitySize={communitySize}
        />
        <MethodologyShowcase
          pillars={METHODOLOGY_PILLARS}
          diagnostics={DIAGNOSTICS}
          disclaimer="Educational analytics only · No betting advice · Users own their decisions"
        />
        <DualServiceSplit analytics={ANALYTICS_SERVICE} customDev={CUSTOM_DEV_SERVICE} />
        <DiscordCTA inviteUrl={discordInvite} communitySize={communitySize} cadence="Twice weekly" />
        <ContactCard />
      </main>
      <ComplianceFooter legalLinks={LEGAL_LINKS} />
    </div>
  );
}
