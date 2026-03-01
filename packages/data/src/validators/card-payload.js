/**
 * Card Payload Validation
 * 
 * Minimal schema guard to prevent invalid payloads from being persisted.
 */

const { z } = require('zod');

const isoDateString = z.string().refine(value => !Number.isNaN(Date.parse(value)), {
  message: 'generated_at must be an ISO date string'
});

const basePayloadSchema = z.object({
  prediction: z.string().min(1),
  confidence: z.number().min(0).max(1),
  recommended_bet_type: z.enum(['moneyline', 'spread', 'puck_line', 'total', 'unknown']),
  generated_at: isoDateString,
  odds_context: z.object({}).passthrough()
});

const driverPayloadSchema = basePayloadSchema.extend({
  tier: z.enum(['SUPER', 'BEST', 'WATCH']).nullable().optional(),
  driver: z.object({
    key: z.string(),
    score: z.number(),
    status: z.string(),
    inputs: z.record(z.unknown())
  })
});

const schemaByCardType = {
  // NHL driver cards
  'nhl-model-output': basePayloadSchema,        // keep for backward compat
  'nhl-goalie': driverPayloadSchema,
  'nhl-special-teams': driverPayloadSchema,
  'nhl-shot-environment': driverPayloadSchema,
  'nhl-empty-net': driverPayloadSchema,
  'nhl-total-fragility': driverPayloadSchema,
  'nhl-pdo-regression': driverPayloadSchema,
  'nhl-welcome-home': driverPayloadSchema,
  'nhl-base-projection': driverPayloadSchema,
  'nhl-rest-advantage': driverPayloadSchema,
  'nhl-pace-totals': driverPayloadSchema,
  'nhl-pace-1p': driverPayloadSchema,
  // NHL market call cards
  'nhl-totals-call': driverPayloadSchema,
  'nhl-spread-call': driverPayloadSchema,
  // NBA driver cards
  'nba-model-output': basePayloadSchema,        // keep for backward compat
  'nba-rest-advantage': driverPayloadSchema,
  'nba-travel': driverPayloadSchema,
  'nba-lineup': driverPayloadSchema,
  'nba-matchup-style': driverPayloadSchema,
  'nba-blowout-risk': driverPayloadSchema,
  'nba-base-projection': driverPayloadSchema,
  'nba-total-projection': driverPayloadSchema,
  'nba-pace-matchup': driverPayloadSchema,
  // NBA market call cards
  'nba-totals-call': driverPayloadSchema,
  'nba-spread-call': driverPayloadSchema,
  // NCAAM driver cards
  'ncaam-base-projection': driverPayloadSchema,
  'ncaam-rest-advantage': driverPayloadSchema,
  'ncaam-matchup-style': driverPayloadSchema,
};

/**
 * Validate card payload data by card type.
 * @param {string} cardType - Card type string
 * @param {object} payloadData - Card payload data
 * @returns {{success: boolean, errors: string[]}}
 */
function validateCardPayload(cardType, payloadData) {
  const schema = schemaByCardType[cardType] || basePayloadSchema;
  const result = schema.safeParse(payloadData);

  if (result.success) {
    return { success: true, errors: [] };
  }

  const errors = result.error.issues.map(issue => `${issue.path.join('.') || 'payload'}: ${issue.message}`);
  return { success: false, errors };
}

module.exports = {
  validateCardPayload
};
