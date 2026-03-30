'use client';

import { useState } from 'react';
import Link from 'next/link';
import FPLPageClient from '@/components/fpl-page-client';
import FPLOnboarding from '@/components/fpl-onboarding';
import FPLDraftLab from '@/components/fpl-draft-lab';
import FPLScreenshotUploader from '@/components/fpl-screenshot-uploader';
import FPLParseReview from '@/components/fpl-parse-review';
import FPLDraftAudit from '@/components/fpl-draft-audit';
import FPLDraftCompare from '@/components/fpl-draft-compare';
import type { ScreenshotParseResponse, ParsedSlot } from '@/lib/fpl-api';

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
        {activeSection === 'onboarding' && (
          <div className="mx-auto max-w-5xl px-6 py-10">
            <FPLOnboarding userId="demo" />
          </div>
        )}
        {activeSection === 'build' && (
          <div className="mx-auto max-w-5xl px-6 py-10">
            <FPLDraftLab userId="demo" />
          </div>
        )}
        {activeSection === 'screenshot' && <ScreenshotAuditSection />}
        {activeSection === 'compare' && (
          <div className="mx-auto max-w-5xl px-6 py-10">
            <FPLDraftCompare />
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Screenshot Audit Section — upload -> review -> audit flow ────────────────

function ScreenshotAuditSection() {
  const [parsedResult, setParsedResult] = useState<ScreenshotParseResponse | null>(null);
  const [resolvedSlots, setResolvedSlots] = useState<ParsedSlot[] | null>(null);
  const [auditSessionId, setAuditSessionId] = useState('');
  const [showAudit, setShowAudit] = useState(false);
  const [pendingSessionId, setPendingSessionId] = useState('');

  const handleResolved = (corrected: ParsedSlot[]) => {
    setResolvedSlots(corrected);
  };

  const handleProceedToAudit = () => {
    if (!pendingSessionId.trim()) return;
    setAuditSessionId(pendingSessionId.trim());
    setShowAudit(true);
  };

  return (
    <div className="mx-auto max-w-5xl px-6 py-10">
      {!parsedResult && (
        <FPLScreenshotUploader onParsed={setParsedResult} />
      )}

      {parsedResult && !resolvedSlots && (
        <FPLParseReview parsed={parsedResult} onResolved={handleResolved} />
      )}

      {resolvedSlots && !showAudit && (
        <div className="space-y-4">
          <div className="rounded-lg border border-teal/20 bg-teal/5 px-4 py-3">
            <p className="text-sm text-teal font-medium">Squad confirmed — {resolvedSlots.length} slots resolved</p>
            <p className="text-xs text-cloud/50 mt-1">Enter a draft session ID to run the audit against.</p>
          </div>
          <div className="flex items-center gap-3 flex-wrap">
            <input
              type="text"
              placeholder="Draft session ID"
              value={pendingSessionId}
              onChange={(e) => setPendingSessionId(e.target.value)}
              className="rounded border border-cloud/20 bg-night px-3 py-2 text-sm text-cloud placeholder-cloud/30 focus:border-teal focus:outline-none"
            />
            <button
              onClick={handleProceedToAudit}
              disabled={!pendingSessionId.trim()}
              className="rounded-lg bg-teal px-5 py-2 text-sm font-semibold text-night hover:opacity-90 disabled:opacity-40 transition-opacity"
            >
              Proceed to Audit
            </button>
          </div>
          <button
            onClick={() => {
              setParsedResult(null);
              setResolvedSlots(null);
              setShowAudit(false);
            }}
            className="text-xs text-cloud/40 hover:text-cloud/60 underline"
          >
            Start over
          </button>
        </div>
      )}

      {showAudit && auditSessionId && (
        <div className="space-y-4">
          <FPLDraftAudit sessionId={auditSessionId} userId="demo" />
          <button
            onClick={() => {
              setParsedResult(null);
              setResolvedSlots(null);
              setShowAudit(false);
              setAuditSessionId('');
              setPendingSessionId('');
            }}
            className="text-xs text-cloud/40 hover:text-cloud/60 underline"
          >
            Start over
          </button>
        </div>
      )}
    </div>
  );
}
