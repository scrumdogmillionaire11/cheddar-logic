import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { AnalysisResults } from '@/lib/api';
import { buildDecisionViewModel } from '@/lib/decisionViewModel';
import TransferSection from '@/components/TransferSection';

describe('Transfer rendering coherence', () => {
  it('dedupes duplicate strategy paths and filters impossible in-targets already in squad', () => {
    const payload: AnalysisResults = {
      primary_decision: 'TRANSFER',
      captain: { name: 'Bukayo Saka', expected_pts: 6.2 },
      vice_captain: { name: 'Cole Palmer', expected_pts: 5.9 },
      transfer_plans: {
        primary: {
          out: 'Player A',
          in: 'Player B',
          hit_cost: 0,
          net_cost: 0,
          reason: 'Primary move',
        },
      },
      starting_xi: [
        { name: 'Player A' },
        { name: 'Existing Mid' },
      ],
      bench: [{ name: 'Bench Player' }],
      strategy_paths: {
        safe: { out: 'Player C', in: 'Player D', rationale: 'Safe path' },
        balanced: { out: 'Player C', in: 'Player D', rationale: 'Duplicate path' },
        aggressive: { out: 'Player E', in: 'Existing Mid', rationale: 'Impossible path' },
      },
    };

    const decision = buildDecisionViewModel(payload);

    expect(decision.captain?.name).toBe('Bukayo Saka');
    expect(decision.viceCaptain?.name).toBe('Cole Palmer');
    expect(decision.transfer.additionalPlans).toHaveLength(1);
    expect(decision.transfer.additionalPlans?.[0].out).toBe('Player C');
    expect(decision.transfer.additionalPlans?.[0].in).toBe('Player D');

    const html = renderToStaticMarkup(
      <TransferSection
        {...decision.transfer}
        freeTransfers={1}
      />
    );

    expect(html).toContain('Player C');
    expect(html).toContain('Player D');
    expect(html).not.toContain('Existing Mid');
  });
});
