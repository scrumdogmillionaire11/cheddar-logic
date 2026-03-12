import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import CaptaincySection from '@/components/CaptaincySection';

describe('CaptaincySection', () => {
  it('hides expected points when captain expected_pts is 0', () => {
    const html = renderToStaticMarkup(
      <CaptaincySection
        captain={{ name: 'Captain Zero', expected_pts: 0, team: 'ARS', position: 'MID' }}
        viceCaptain={{ name: 'Vice One', expected_pts: 1, team: 'LIV', position: 'MID' }}
      />
    );

    // 0.0 pts should NOT be displayed for captain
    expect(html).not.toContain('Captain Zero</span><span class="text-body-sm text-execute font-medium">0.0 pts');
    // 1.0 pts SHOULD be displayed for vice captain
    expect(html).toContain('1.0 pts');
  });

  it('displays expected points when captain expected_pts is positive', () => {
    const html = renderToStaticMarkup(
      <CaptaincySection
        captain={{ name: 'Captain Good', expected_pts: 8.5, team: 'MCI', position: 'FWD' }}
        viceCaptain={{ name: 'Vice High', expected_pts: 7.2, team: 'AVL', position: 'MID' }}
      />
    );

    expect(html).toContain('8.5 pts');
    expect(html).toContain('7.2 pts');
  });
});
