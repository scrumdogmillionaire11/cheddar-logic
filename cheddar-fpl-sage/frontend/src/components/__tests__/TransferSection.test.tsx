import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { AnalysisResults } from '@/lib/api';
import { buildDecisionViewModel } from '@/lib/decisionViewModel';
import TransferSection from '@/components/TransferSection';

describe('Transfer rendering coherence', () => {
  it('renders canonical transfer alternatives exactly as provided', () => {
    const payload: AnalysisResults = {
      weekly_review: {
        version: 'v1',
        summary: 'Review',
        highlights: [],
        metrics: {},
      },
      squad_state: {
        version: 'v1',
        summary: 'Squad status',
        highlights: [],
        metrics: {
          starting_xi: [{ name: 'Player A' }, { name: 'Existing Mid' }],
          bench: [{ name: 'Bench Player' }],
        },
      },
      gameweek_plan: {
        version: 'v1',
        summary: 'Plan summary',
        highlights: [],
        metrics: {
          primary_action: 'TRANSFER',
        },
      },
      transfer_recommendation: {
        version: 'v1',
        summary: 'Transfers',
        highlights: [],
        metrics: {
          transfer_plans: {
            primary: {
              out: 'Player A',
              in: 'Player B',
              hit_cost: 0,
              net_cost: 0,
              reason: 'Primary move',
            },
            additional: [
              {
                out: 'Player C',
                in: 'Player D',
                hit_cost: 0,
                net_cost: 0,
                reason: 'Safe path',
              },
              {
                out: 'Player E',
                in: 'Existing Mid',
                hit_cost: 0,
                net_cost: 0,
                reason: 'Aggressive path',
              },
            ],
          },
        },
      },
      captaincy: {
        version: 'v1',
        summary: 'Captaincy summary',
        highlights: [],
        metrics: {
          captain: { name: 'Bukayo Saka', expected_pts: 6.2 },
          vice_captain: { name: 'Cole Palmer', expected_pts: 5.9 },
        },
      },
      chip_strategy: {
        version: 'v1',
        summary: 'Chip summary',
        highlights: [],
        metrics: {
          verdict: 'NONE',
          status: 'PASS',
          explanation: 'No chip this week.',
        },
      },
      horizon_watch: {
        version: 'v1',
        summary: 'Horizon',
        highlights: [],
        metrics: {},
      },
      decision_confidence: {
        version: 'v1',
        confidence: 'MEDIUM',
        score: 72,
        rationale: 'Solid but not urgent.',
        signals: ['baseline'],
      },
    };

    const decision = buildDecisionViewModel(payload);

    expect(decision.captain?.name).toBe('Bukayo Saka');
    expect(decision.viceCaptain?.name).toBe('Cole Palmer');
    expect(decision.transfer.additionalPlans).toHaveLength(2);
    expect(decision.transfer.additionalPlans?.[0].out).toBe('Player C');
    expect(decision.transfer.additionalPlans?.[0].in).toBe('Player D');
    expect(decision.transfer.additionalPlans?.[1].in).toBe('Existing Mid');

    const html = renderToStaticMarkup(
      <TransferSection
        {...decision.transfer}
        freeTransfers={1}
      />
    );

    expect(html).toContain('Player C');
    expect(html).toContain('Player D');
    expect(html).toContain('Existing Mid');
  });
});
