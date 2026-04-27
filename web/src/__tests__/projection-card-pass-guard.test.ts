import assert from 'node:assert/strict';

import ProjectionCard from '../components/projection-card';

const baseProps = {
  homeTeam: 'Houston Astros',
  awayTeam: 'Colorado Rockies',
  startTime: new Date('2026-04-16T19:00:00Z').toISOString(),
};

const passRender = ProjectionCard({
  ...baseProps,
  sport: 'MLB',
  play: {
    cardType: 'mlb-f5',
    projectedTotal: 9.2,
    line: 8.5,
    confidence: 0.74,
    tier: 'BEST',
    reasoning: 'No edge at current price',
    decision_v2: {
      canonical_envelope_v2: {
        official_status: 'PASS',
      },
    },
  },
});

assert.equal(
  passRender,
  null,
  'ProjectionCard should not render PASS projection rows',
);

const playableRender = ProjectionCard({
  ...baseProps,
  sport: 'MLB',
  play: {
    cardType: 'mlb-f5',
    projectedTotal: 9.2,
    line: 8.5,
    confidence: 0.74,
    tier: 'BEST',
    reasoning: 'Actionable edge persists',
    decision_v2: {
      canonical_envelope_v2: {
        official_status: 'PLAY',
      },
    },
    selection: { side: 'OVER' },
  },
});

assert.notEqual(
  playableRender,
  null,
  'ProjectionCard should render actionable projection rows',
);

console.log('ProjectionCard PASS guard tests passed');
