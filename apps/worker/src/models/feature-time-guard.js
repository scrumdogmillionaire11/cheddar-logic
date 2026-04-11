'use strict';

/**
 * WI-0827: Feature timestamp audit — block future event-time violations.
 *
 * High-risk fields that must have available_at <= betPlacedAt.
 * Phase 1: violations produce a WARN log and are recorded in card payload
 * metadata. They do NOT hard-block. Phase 2 (after two weeks of data):
 * violations on confirmed-leaky fields will hard-block to NO_BET.
 */
const HIGH_RISK_FIELDS = [
  'umpire_factor',
  'homeGoalieCertainty',
  'awayGoalieCertainty',
  'homeGoalsForL5',
  'awayGoalsForL5',
  'homeGoalsAgainstL5',
  'awayGoalsAgainstL5',
  'rolling_14d_wrc_plus_vs_hand',
];

/**
 * Assert that every tracked high-risk feature was available before the bet
 * decision time. Fields with no `available_at` entry are skipped in Phase 1.
 *
 * @param {object} rawData       - parsed raw_data from odds snapshot or card
 * @param {string} betPlacedAt   - ISO8601 timestamp of bet decision
 * @returns {{ ok: boolean, violations: Array<{field: string, available_at: string, bet_placed_at: string}> }}
 */
function assertFeatureTimeliness(rawData, betPlacedAt) {
  const timestamps = rawData?.feature_timestamps ?? {};
  const betTime = new Date(betPlacedAt).getTime();
  const violations = [];

  if (!Number.isFinite(betTime)) {
    return { ok: true, violations: [] };
  }

  for (const field of HIGH_RISK_FIELDS) {
    const availableAt = timestamps[field];
    if (availableAt == null) continue; // not tracked yet — skip in Phase 1
    const availableTime = new Date(availableAt).getTime();
    if (!Number.isFinite(availableTime)) continue;
    if (availableTime > betTime) {
      violations.push({ field, available_at: availableAt, bet_placed_at: betPlacedAt });
    }
  }

  return { ok: violations.length === 0, violations };
}

module.exports = { assertFeatureTimeliness, HIGH_RISK_FIELDS };
