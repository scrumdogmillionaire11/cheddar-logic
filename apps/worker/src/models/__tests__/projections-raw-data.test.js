const { assessProjectionInputs } = require('../projections');

describe('assessProjectionInputs raw_data parsing', () => {
  test('recovers espn_metrics from double-encoded raw_data JSON', () => {
    const rawPayload = {
      espn_metrics: {
        home: { metrics: { avgGoalsFor: 3.1, avgGoalsAgainst: 2.8 } },
        away: { metrics: { avgGoalsFor: 2.9, avgGoalsAgainst: 3.2 } },
      },
    };

    const gate = assessProjectionInputs('NHL', {
      raw_data: JSON.stringify(JSON.stringify(rawPayload)),
    });

    expect(gate.projection_inputs_complete).toBe(true);
    expect(gate.missing_inputs).toEqual([]);
  });
});
