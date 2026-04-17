import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { AnalysisResults } from '@/lib/api';
import DecisionBrief from '@/components/DecisionBrief';
import { buildDecisionViewModel } from '@/lib/decisionViewModel';
import { WEEKLY_SECTION_ORDER } from '@/pages/Results';

describe('DecisionBrief', () => {
  it('renders backend confidence label and summary when provided', () => {
    const html = renderToStaticMarkup(
      <DecisionBrief
        primaryAction="TRANSFER"
        confidence="MED"
        justification="Backend decision justification"
        gameweek={31}
        confidenceLabel="HIGH"
        confidenceSummary="Confidence remains high due to fixture swing and role certainty."
      />
    );

    expect(html).toContain('HIGH');
    expect(html).toContain('Confidence remains high due to fixture swing and role certainty.');
  });

  it('keeps deterministic weekly section order contract', () => {
    expect(WEEKLY_SECTION_ORDER).toEqual([
      'weekly_review',
      'current_squad_state',
      'gameweek_plan',
      'transfer_recommendation',
      'captaincy',
      'chip_strategy',
      'horizon_watch',
    ]);
  });

  it('maps weekly review from canonical card and handles null card safely', () => {
    const canonicalPayload: AnalysisResults = {
      weekly_review: {
        version: 'v1',
        summary: 'Retrospective review captured from previous gameweek data.',
        highlights: ['Previous GW points: 66'],
        metrics: {},
      },
      squad_state: { version: 'v1', summary: 'Squad status', highlights: [], metrics: {} },
      gameweek_plan: { version: 'v1', summary: 'Plan summary', highlights: [], metrics: { primary_action: 'ROLL' } },
      transfer_recommendation: { version: 'v1', summary: 'Transfers', highlights: [], metrics: {} },
      captaincy: { version: 'v1', summary: 'Captaincy', highlights: [], metrics: {} },
      chip_strategy: {
        version: 'v1',
        summary: 'Chip',
        highlights: [],
        metrics: { verdict: 'NONE', status: 'PASS', explanation: 'No chip this week.' },
      },
      horizon_watch: { version: 'v1', summary: 'Horizon', highlights: [], metrics: {} },
      decision_confidence: {
        version: 'v1',
        confidence: 'MEDIUM',
        score: 70,
        rationale: 'Stable confidence.',
        signals: ['baseline'],
      },
    };

    const decisionWithReview = buildDecisionViewModel(canonicalPayload);
    expect(decisionWithReview.weeklyReview?.summary).toContain('Retrospective review captured');

    const nullWeeklyReviewPayload = {
      ...canonicalPayload,
      weekly_review: null,
    } as unknown as AnalysisResults;

    const decisionWithoutReview = buildDecisionViewModel(nullWeeklyReviewPayload);
    expect(decisionWithoutReview.weeklyReview).toBeNull();
  });
});
