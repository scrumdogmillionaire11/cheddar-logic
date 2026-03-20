const { gradeAsianHandicap } = require('../asian-handicap-grader');

describe('asian handicap grader', () => {
  test('whole line returns win|push|loss outcomes', () => {
    const win = gradeAsianHandicap({ team_goals: 2, opponent_goals: 0, handicap: -1.0 });
    const push = gradeAsianHandicap({ team_goals: 2, opponent_goals: 1, handicap: -1.0 });
    const loss = gradeAsianHandicap({ team_goals: 1, opponent_goals: 1, handicap: -1.0 });

    expect(win.success).toBe(true);
    expect(win.line_type).toBe('WHOLE');
    expect(win.outcome).toBe('win');

    expect(push.success).toBe(true);
    expect(push.outcome).toBe('push');

    expect(loss.success).toBe(true);
    expect(loss.outcome).toBe('loss');
  });

  test('half line returns win|loss outcomes', () => {
    const win = gradeAsianHandicap({ team_goals: 1, opponent_goals: 0, handicap: -0.5 });
    const loss = gradeAsianHandicap({ team_goals: 1, opponent_goals: 1, handicap: -0.5 });

    expect(win.success).toBe(true);
    expect(win.line_type).toBe('HALF');
    expect(win.outcome).toBe('win');

    expect(loss.success).toBe(true);
    expect(loss.line_type).toBe('HALF');
    expect(loss.outcome).toBe('loss');
  });

  test('zero line returns win|push|loss outcomes', () => {
    const win = gradeAsianHandicap({ team_goals: 2, opponent_goals: 1, handicap: 0 });
    const push = gradeAsianHandicap({ team_goals: 1, opponent_goals: 1, handicap: 0 });
    const loss = gradeAsianHandicap({ team_goals: 1, opponent_goals: 2, handicap: 0 });

    expect(win.success).toBe(true);
    expect(win.line_type).toBe('ZERO');
    expect(win.outcome).toBe('win');

    expect(push.success).toBe(true);
    expect(push.outcome).toBe('push');

    expect(loss.success).toBe(true);
    expect(loss.outcome).toBe('loss');
  });

  test('quarter line -0.75 grades half_win when team wins by 1', () => {
    const result = gradeAsianHandicap({ team_goals: 2, opponent_goals: 1, handicap: -0.75 });

    expect(result.success).toBe(true);
    expect(result.line_type).toBe('QUARTER');
    expect(result.split_handicaps).toEqual([-0.5, -1]);
    expect(result.outcome).toBe('half_win');
  });

  test('quarter line +0.75 grades half_loss when team loses by 1', () => {
    const result = gradeAsianHandicap({ team_goals: 0, opponent_goals: 1, handicap: 0.75 });

    expect(result.success).toBe(true);
    expect(result.line_type).toBe('QUARTER');
    expect(result.split_handicaps).toEqual([0.5, 1]);
    expect(result.outcome).toBe('half_loss');
  });

  test('rejects malformed handicap line with explicit reason code', () => {
    const result = gradeAsianHandicap({ team_goals: 1, opponent_goals: 1, handicap: 0.3 });

    expect(result.success).toBe(false);
    expect(result.reason_code).toBe('INVALID_HANDICAP_LINE');
  });
});
