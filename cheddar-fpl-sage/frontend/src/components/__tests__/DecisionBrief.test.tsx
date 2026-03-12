import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import DecisionBrief from '@/components/DecisionBrief';

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
});
