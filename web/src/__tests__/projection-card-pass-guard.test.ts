import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';

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

assert.notEqual(
  passRender,
  null,
  'ProjectionCard should continue rendering passive projection rows in the projections surface',
);

const passMarkup = renderToStaticMarkup(passRender!);
assert.match(
  passMarkup,
  /PASS/,
  'ProjectionCard should still show the passive state for non-actionable projection rows',
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

const projectionOnlyOfficialRender = ProjectionCard({
  ...baseProps,
  sport: 'MLB',
  play: {
    cardType: 'mlb-f5',
    projectedTotal: 3.2,
    projectedAwayF5Runs: 1.5,
    projectedHomeF5Runs: 1.7,
    confidence: 0.68,
    tier: 'WATCH',
    reasoning: 'Official under call must surface before settlement',
    execution_status: 'PROJECTION_ONLY',
    projection_settlement_policy: {
      market_family: 'MLB_F5_TOTAL',
      grading_mode: 'OFFICIAL',
      official_call: 'UNDER_3_5',
      reason_code: 'CLEAR_UNDER',
    },
    decision_v2: {
      canonical_envelope_v2: {
        official_status: 'PLAY',
      },
    },
  },
});

assert.notEqual(
  projectionOnlyOfficialRender,
  null,
  'ProjectionCard should render MLB F5 projection-only rows with an official call',
);

const projectionOnlyOfficialMarkup = renderToStaticMarkup(
  projectionOnlyOfficialRender!,
);
assert.match(
  projectionOnlyOfficialMarkup,
  /UNDER 3\.5/,
  'ProjectionCard should surface the persisted official MLB F5 call badge before settlement',
);
assert.match(
  projectionOnlyOfficialMarkup,
  /official UNDER 3\.5 call/,
  'ProjectionCard should explain that the pre-settlement wedge is using the official persisted call',
);

const projectionOnlyTrackOnlyRender = ProjectionCard({
  ...baseProps,
  sport: 'MLB',
  play: {
    cardType: 'mlb-f5',
    projectedTotal: 3.9,
    confidence: 0.5,
    tier: 'WATCH',
    reasoning: 'Gray-zone rows stay track-only',
    execution_status: 'PROJECTION_ONLY',
    projection_settlement_policy: {
      market_family: 'MLB_F5_TOTAL',
      grading_mode: 'TRACK_ONLY',
      official_call: null,
      reason_code: 'GRAY_ZONE_NO_CALL',
    },
    decision_v2: {
      canonical_envelope_v2: {
        official_status: 'PLAY',
      },
    },
  },
});

assert.notEqual(
  projectionOnlyTrackOnlyRender,
  null,
  'ProjectionCard should still render track-only MLB F5 rows',
);

const projectionOnlyTrackOnlyMarkup = renderToStaticMarkup(
  projectionOnlyTrackOnlyRender!,
);
assert.doesNotMatch(
  projectionOnlyTrackOnlyMarkup,
  /UNDER 3\.5|OVER 4\.5/,
  'ProjectionCard should not invent an official call for TRACK_ONLY MLB F5 rows',
);
assert.match(
  projectionOnlyTrackOnlyMarkup,
  /No official call/,
  'ProjectionCard should label gray-zone MLB F5 rows as track-only before settlement',
);

console.log('ProjectionCard MLB F5 projection-call rendering tests passed');
