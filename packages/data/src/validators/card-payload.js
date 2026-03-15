/**
 * Card Payload Validation
 * 
 * Minimal schema guard to prevent invalid payloads from being persisted.
 */

const { z } = require('zod');
const { deriveLockedMarketContext } = require('../market-contract');

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

const nullableNumber = z.number().nullable();

const soccerPayloadSchema = basePayloadSchema.extend({
  kind: z.literal('PLAY'),
  market_type: z.literal('MONEYLINE'),
  period: z.enum(['FULL_GAME', 'REGULATION']).optional(),
  recommended_bet_type: z.literal('moneyline'),
  selection: z.object({
    side: z.enum(['HOME', 'AWAY']),
    team: z.string().min(1),
  }),
  price: z.number().int(),
  line: z.null().optional(),
  recommendation: z.object({
    type: z.enum(['ML_HOME', 'ML_AWAY']),
    text: z.string().min(1),
    pass_reason: z.null().optional(),
  }),
  drivers_active: z.array(z.string().min(1)).min(1),
  projection: z.object({
    total: nullableNumber.optional(),
    margin_home: nullableNumber.optional(),
    win_prob_home: nullableNumber.optional(),
  }),
  projection_context: z.object({
    source: z.string().min(1),
    available: z.boolean(),
    unsupported_projection_fields: z.array(z.string()).optional(),
    missing_fields: z.array(z.string()),
    fallback_mode: z.string().nullable().optional(),
  }),
  market_context: z
    .object({
      version: z.string().optional(),
      market_type: z.literal('MONEYLINE'),
      period: z.string().optional(),
      selection_side: z.enum(['HOME', 'AWAY']).optional(),
      selection_team: z.string().min(1).nullable().optional(),
      projection: z
        .object({
          total: nullableNumber.optional(),
          margin_home: nullableNumber.optional(),
          win_prob_home: nullableNumber.optional(),
        })
        .partial()
        .optional(),
      wager: z
        .object({
          called_line: z.null().optional(),
          called_price: z.number().int().nullable().optional(),
          line_source: z.string().nullable().optional(),
          price_source: z.string().nullable().optional(),
          period: z.string().optional(),
        })
        .partial()
        .optional(),
    })
    .partial()
    .optional(),
  odds_context: z.object({
    h2h_home: z.number(),
    h2h_away: z.number(),
    captured_at: z.string().optional(),
  }).passthrough(),
  meta: z.object({
    inference_source: z.string().min(1),
    model_endpoint: z.string().nullable().optional(),
    is_mock: z.boolean(),
    hardening_version: z.string().optional(),
    league_context: z.string().optional(),
    missing_context_fields: z.array(z.string()),
  }).passthrough(),
}).superRefine((payload, ctx) => {
  if (
    payload.recommended_bet_type === 'unknown' ||
    payload.recommended_bet_type === 'spread' ||
    payload.recommended_bet_type === 'total' ||
    payload.recommended_bet_type === 'puck_line'
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['recommended_bet_type'],
      message: 'soccer-model-output must not use placeholder/non-moneyline bet types',
    });
  }
});

// ============================================================================
// Ohio soccer scope validator (soccer-ohio-scope cardType)
// ============================================================================

const OHIO_CANONICAL_KEYS = [
  'player_shots',
  'team_totals',
  'to_score_or_assist',
  'player_shots_on_target',
  'anytime_goalscorer',
  'team_corners',
];

const PLACEHOLDER_STRINGS = new Set(['unknown', 'tbd', 'n/a', '']);

const soccerOhioScopeSchema = z
  .object({
    canonical_market_key: z.enum(OHIO_CANONICAL_KEYS),
    market_family: z.enum(['tier1', 'tier2']),
    sport: z.literal('SOCCER'),
    game_id: z.string().min(1),
    home_team: z.string().min(1).nullable(),
    away_team: z.string().min(1).nullable(),
    generated_at: isoDateString,
    missing_context_flags: z.array(z.string()),
    pass_reason: z.string().nullable(),
    projection_basis: z.string().nullable(),
    edge_ev: z.number().nullable(),
    price: z.number().int().nullable(),
    eligibility: z
      .object({
        starter_signal: z.boolean().optional(),
        proj_minutes: z.number().nullable().optional(),
        role_tags: z.array(z.string()).optional(),
        per90_hints: z.record(z.unknown()).optional(),
      })
      .optional(),
  })
  .passthrough()
  .superRefine((payload, ctx) => {
    const { canonical_market_key, price, projection_basis, edge_ev, missing_context_flags } =
      payload;

    // 1. Price caps per market key
    if (
      canonical_market_key === 'player_shots' &&
      price !== null &&
      price !== undefined &&
      price < -150
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['price'],
        message: 'price_cap: player_shots price must be >= -150',
      });
    }

    if (
      canonical_market_key === 'to_score_or_assist' &&
      price !== null &&
      price !== undefined &&
      price < -140
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['price'],
        message: 'price_cap: tsoa price must be >= -140',
      });
    }

    if (
      canonical_market_key === 'player_shots_on_target' &&
      price !== null &&
      price !== undefined &&
      price < -130
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['price'],
        message: 'price_cap: sot price must be >= -130',
      });
    }

    if (
      canonical_market_key === 'anytime_goalscorer' &&
      price !== null &&
      price !== undefined &&
      price <= 180
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['price'],
        message: 'price_cap: anytime_goalscorer must be priced > +180',
      });
    }

    // 2. Placeholder rejection for projection_basis
    if (
      projection_basis !== null &&
      projection_basis !== undefined &&
      typeof projection_basis === 'string' &&
      PLACEHOLDER_STRINGS.has(projection_basis.toLowerCase())
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['projection_basis'],
        message:
          'placeholder: projection_basis cannot be a placeholder string',
      });
    }

    // 3. Fake projection rejection: edge_ev=0 without missing_context_flags acknowledgement
    if (
      edge_ev === 0 &&
      Array.isArray(missing_context_flags) &&
      !missing_context_flags.includes('edge_ev')
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['edge_ev'],
        message:
          'fake_projection: edge_ev=0 without missing_context_flags acknowledgement',
      });
    }
  });

const schemaByCardType = {
  // Active NHL driver + evidence cards
  'nhl-goalie': driverPayloadSchema,
  'nhl-goalie-certainty': driverPayloadSchema,
  'nhl-special-teams': driverPayloadSchema,
  'nhl-shot-environment': driverPayloadSchema,
  'nhl-empty-net': driverPayloadSchema,
  'nhl-total-fragility': driverPayloadSchema,
  'nhl-pdo-regression': driverPayloadSchema,
  'nhl-base-projection': driverPayloadSchema,
  'nhl-rest-advantage': driverPayloadSchema,
  'nhl-pace-totals': driverPayloadSchema,
  'nhl-pace-1p': driverPayloadSchema,
  'nhl-player-shots': driverPayloadSchema,
  'nhl-player-shots-1p': driverPayloadSchema,
  'welcome-home-v2': driverPayloadSchema,

  // Active NHL market call cards
  'nhl-totals-call': driverPayloadSchema,
  'nhl-spread-call': driverPayloadSchema,
  'nhl-moneyline-call': driverPayloadSchema,

  // Active NBA driver + evidence cards
  'nba-rest-advantage': driverPayloadSchema,
  'nba-travel': driverPayloadSchema,
  'nba-lineup': driverPayloadSchema,
  'nba-matchup-style': driverPayloadSchema,
  'nba-blowout-risk': driverPayloadSchema,
  'nba-base-projection': driverPayloadSchema,
  'nba-total-projection': driverPayloadSchema,
  'nba-pace-matchup': driverPayloadSchema,

  // Active NBA market call cards
  'nba-totals-call': driverPayloadSchema,
  'nba-spread-call': driverPayloadSchema,
  'nba-moneyline-call': driverPayloadSchema,

  // Active NCAAM cards (includes legacy type still emitted in current runs)
  'ncaam-base-projection': driverPayloadSchema,
  'ncaam-rest-advantage': driverPayloadSchema,
  'ncaam-matchup-style': driverPayloadSchema,
  'ncaam-ft-trend': driverPayloadSchema,
  'ncaam-ft-spread': driverPayloadSchema,

  // Active single-card model output jobs
  'soccer-model-output': soccerPayloadSchema,
  'soccer-ohio-scope': soccerOhioScopeSchema,
  'mlb-model-output': basePayloadSchema,
  'nfl-model-output': basePayloadSchema,
  'fpl-model-output': basePayloadSchema,

  // Legacy aliases retained for backward compatibility.
  // Keep accepted so historical rows remain valid, but no new writes should target deprecated aliases.
  'nhl-model-output': basePayloadSchema, // keep (historical + currently read as NHL evidence card)
  'nba-model-output': basePayloadSchema, // deprecated write alias; kept for historical payloads
  'nhl-welcome-home': driverPayloadSchema, // deprecated alias; canonical replacement is welcome-home-v2
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
    // Soccer ohio-scope cards use a self-contained validator; skip the
    // deriveLockedMarketContext check which only handles SPREAD/TOTAL/MONEYLINE.
    if (cardType !== 'soccer-ohio-scope') {
      try {
        // Parser boundary guard: actionable plays must satisfy strict market/selection contract.
        // Note: requirePrice=false allows cards to be generated even if odds prices aren't fully populated.
        // Prices will be fetched at betting time if needed.
        deriveLockedMarketContext(payloadData, {
          gameId: payloadData?.game_id,
          homeTeam: payloadData?.home_team,
          awayTeam: payloadData?.away_team,
          requirePrice: false,
          requireLineForMarket: true,
        });
      } catch (error) {
        const errorCode = error?.code || 'INVALID_MARKET_CONTRACT';
        return { success: false, errors: [`market_contract: ${errorCode} ${error.message}`] };
      }
    }

    return { success: true, errors: [] };
  }

  const errors = result.error.issues.map(issue => `${issue.path.join('.') || 'payload'}: ${issue.message}`);
  return { success: false, errors };
}

module.exports = {
  validateCardPayload
};
