'use client';

import { useState } from 'react';
import Link from 'next/link';
import FPLPageClient from '@/components/fpl-page-client';

type Section = 'onboarding' | 'build' | 'screenshot' | 'compare' | 'weekly';

const SECTIONS: Array<{
  id: Section;
  label: string;
  icon: string;
  description: string;
}> = [
  {
    id: 'onboarding',
    label: 'Profile',
    icon: '👤',
    description: 'Set up your manager profile and archetype',
  },
  {
    id: 'build',
    label: 'Build Lab',
    icon: '🔬',
    description: 'Draft and iterate on squad options',
  },
  {
    id: 'screenshot',
    label: 'Squad Audit',
    icon: '📸',
    description: 'Parse your squad from a screenshot',
  },
  {
    id: 'compare',
    label: 'Compare',
    icon: '⚖️',
    description: 'Compare two draft sessions side-by-side',
  },
  {
    id: 'weekly',
    label: 'Weekly',
    icon: '🧙‍♂️',
    description: 'Run weekly transfer and chip analysis',
  },
];

export default function FPLProductShell() {
  const [activeSection, setActiveSection] = useState<Section>('weekly');

  return (
    <div className="min-h-screen bg-night text-cloud">
      {/* Top bar */}
      <div className="border-b border-cloud/10">
        <div className="mx-auto flex max-w-5xl items-center justify-between px-6 py-4">
          <Link href="/" className="text-sm text-cloud/60 hover:text-cloud/80">
            ← Back to Home
          </Link>
          <span className="font-display text-xl font-semibold">FPL Sage</span>
          <span className="rounded bg-teal/10 px-2 py-0.5 text-xs font-semibold text-teal">
            v2
          </span>
        </div>

        {/* Section tabs */}
        <div className="mx-auto max-w-5xl overflow-x-auto px-6">
          <div className="flex gap-0">
            {SECTIONS.map((s) => (
              <button
                key={s.id}
                onClick={() => setActiveSection(s.id)}
                className={`flex items-center gap-1.5 whitespace-nowrap border-b-2 px-4 py-2.5 text-sm font-medium transition-colors ${
                  activeSection === s.id
                    ? 'border-teal text-cloud'
                    : 'border-transparent text-cloud/50 hover:text-cloud/80'
                }`}
              >
                <span>{s.icon}</span>
                <span>{s.label}</span>
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Section content */}
      <div>
        {activeSection === 'weekly' && <FPLPageClient embedded />}
        {activeSection === 'onboarding' && <OnboardingSection />}
        {activeSection === 'build' && <BuildLabSection />}
        {activeSection === 'screenshot' && <ScreenshotAuditSection />}
        {activeSection === 'compare' && <CompareSection />}
      </div>
    </div>
  );
}

// ─── Section placeholders ─────────────────────────────────────────────────────
// Detailed controls for non-weekly sections are out of scope for WI-0659.
// Each section is scaffolded and ready for WI-0660/0661 to fill in.

function OnboardingSection() {
  return (
    <div className="mx-auto max-w-5xl px-6 py-10 space-y-6">
      <div>
        <h2 className="mb-1 font-display text-2xl font-semibold">
          Manager Profile
        </h2>
        <p className="text-cloud/60">
          Create or update your FPL manager profile to unlock archetype-aware
          advice tailored to your play style.
        </p>
      </div>

      <div className="rounded-xl border border-cloud/10 bg-surface/50 p-8">
        <div className="mb-4 flex items-start gap-4">
          <span className="text-3xl">👤</span>
          <div>
            <p className="font-semibold">Profile &amp; Archetype Setup</p>
            <p className="mt-1 text-sm text-cloud/60">
              Answer a short questionnaire to map your manager style to one of
              five FPL archetypes: Rank Climber, Chip Strategist, Differential
              Hunter, Template Follower, or Wildcard Gambler. Your archetype
              unlocks personalised risk thresholds and transfer logic.
            </p>
          </div>
        </div>
        <div className="rounded-lg border border-cloud/5 bg-cloud/5 px-4 py-3 text-sm text-cloud/50">
          Available after WI-0653 backend implementation — profile onboarding
          APIs are in queue.
        </div>
      </div>
    </div>
  );
}

function BuildLabSection() {
  return (
    <div className="mx-auto max-w-5xl px-6 py-10 space-y-6">
      <div>
        <h2 className="mb-1 font-display text-2xl font-semibold">Build Lab</h2>
        <p className="text-cloud/60">
          Create draft sessions, iterate on squad options, and generate
          AI-powered squad recommendations.
        </p>
      </div>

      <div className="rounded-xl border border-cloud/10 bg-surface/50 p-8">
        <div className="mb-4 flex items-start gap-4">
          <span className="text-3xl">🔬</span>
          <div>
            <p className="font-semibold">Draft Sessions &amp; Builder</p>
            <p className="mt-1 text-sm text-cloud/60">
              Start a draft session with candidate players and let the engine
              build the optimal squad, score each draft on eight dimensions, and
              surface audit findings before you commit.
            </p>
          </div>
        </div>
        <div className="rounded-lg border border-cloud/5 bg-cloud/5 px-4 py-3 text-sm text-cloud/50">
          Available after WI-0654 draft-sessions backend — builder controls are
          in queue.
        </div>
      </div>
    </div>
  );
}

function ScreenshotAuditSection() {
  return (
    <div className="mx-auto max-w-5xl px-6 py-10 space-y-6">
      <div>
        <h2 className="mb-1 font-display text-2xl font-semibold">
          Squad Audit
        </h2>
        <p className="text-cloud/60">
          Upload 1–3 screenshots of your FPL app to parse your current squad
          automatically.
        </p>
      </div>

      <div className="rounded-xl border border-cloud/10 bg-surface/50 p-8">
        <div className="mb-4 flex items-start gap-4">
          <span className="text-3xl">📸</span>
          <div>
            <p className="font-semibold">Screenshot Parser</p>
            <p className="mt-1 text-sm text-cloud/60">
              The backend accepts up to three base64-encoded FPL mobile
              screenshots, detects the layout, fuzzy-matches player names via
              the player registry, and returns a confidence-scored 15-man parsed
              squad. Low-confidence slots are surfaced explicitly — never silent
              completions.
            </p>
          </div>
        </div>
        <div className="rounded-lg border border-cloud/5 bg-cloud/5 px-4 py-3 text-sm text-cloud/50">
          Screenshot correction UI is out of scope for WI-0659 — upload
          controls arrive in WI-0660.
        </div>
      </div>
    </div>
  );
}

function CompareSection() {
  return (
    <div className="mx-auto max-w-5xl px-6 py-10 space-y-6">
      <div>
        <h2 className="mb-1 font-display text-2xl font-semibold">
          Compare Drafts
        </h2>
        <p className="text-cloud/60">
          Compare two draft sessions side-by-side across eight weighted
          dimensions.
        </p>
      </div>

      <div className="rounded-xl border border-cloud/10 bg-surface/50 p-8">
        <div className="mb-4 flex items-start gap-4">
          <span className="text-3xl">⚖️</span>
          <div>
            <p className="font-semibold">Archetype-Weighted Comparison</p>
            <p className="mt-1 text-sm text-cloud/60">
              Submit two draft-session IDs and receive a dimension-by-dimension
              winner breakdown weighted by your manager archetype. The engine
              identifies which squad better matches your play style and
              highlights the decisive deltas.
            </p>
          </div>
        </div>
        <div className="rounded-lg border border-cloud/5 bg-cloud/5 px-4 py-3 text-sm text-cloud/50">
          Compare UI controls arrive in WI-0661 — the backend comparison API is
          already live.
        </div>
      </div>
    </div>
  );
}
