/**
 * Card Payload Validation
 *
 * CONTRACT — Write path:
 *   Worker jobs (run_nhl_model, run_soccer_model, run_nhl_player_shots_model, etc.)
 *   → packages/data (saveCardPayload / upsertCardPayload)
 *   → card_payloads table
 *
 * CONTRACT — Read surfaces (active):
 *   GET /api/games        — joined with card_payloads for play-call data
 *   GET /api/cards        — primary betting dashboard card feed
 *   GET /api/cards/[gameId] — per-game card detail
 *
 * Backward compatibility:
 *   Legacy aliases in schemaByCardType are retained per the "Legacy Alias Policy" table
 *   in docs/DATA_CONTRACTS.md. Accepted for historical rows; no new writes should target
 *   deprecated aliases.
 *
 * Historical-only (not active runtime contracts):
 *   server/model-outputs, /api/models/*, /api/betting/projections, /api/soccer/slate
 *   These references appear in older commits only and do not exist in the current architecture.
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

const marketEnum = z.enum(['TOTAL', 'SPREAD', 'ML']);
const sideEnum = z.enum(['OVER', 'UNDER', 'HOME', 'AWAY']);

const expressionChoiceSchema = z.object({
  chosen_market: marketEnum,
  pick: z.string().min(1),
  status: z.enum(['FIRE', 'WATCH', 'PASS']),
  score: z.number(),
  net: z.number(),
  edge: z.number().nullable(),
  chosen: z
    .object({
      market: marketEnum,
      side: sideEnum.nullable(),
      line: z.number().nullable().optional(),
      price: z.number().nullable().optional(),
      status: z.enum(['FIRE', 'WATCH', 'PASS']),
      score: z.number(),
      net: z.number(),
      conflict: z.number(),
      edge: z.number().nullable(),
    })
    .nullable()
    .optional(),
});

const marketNarrativeSchema = z.object({
  chosen_story: z.string().min(1),
  alternatives: z.record(z.string()).default({}),
  orchestration: z.string().min(1),
});

const nhlMarketCallPayloadSchema = driverPayloadSchema.extend({
  expression_choice: expressionChoiceSchema,
  market_narrative: marketNarrativeSchema,
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
    projection_only: z.boolean().optional(),
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

    // 1. Price caps per market key (skip when projection_only flag is set)
    if (!payload.projection_only) {
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

// ============================================================================
// New odds-backed soccer card schemas
// ============================================================================

const soccerMlSchema = z.object({
  sport: z.literal('SOCCER'),
  game_id: z.string().min(1),
  home_team: z.string().min(1).nullable(),
  away_team: z.string().min(1).nullable(),
  generated_at: isoDateString,
  market_type: z.literal('MONEYLINE'),
  selection: z.object({ side: z.enum(['HOME', 'AWAY']), team: z.string().min(1).nullable() }),
  price: z.number().int().nullable(),
  edge_basis: z.string().nullable(),
  missing_context_flags: z.array(z.string()),
  pass_reason: z.string().nullable(),
}).passthrough();

const soccerGameTotalSchema = z.object({
  sport: z.literal('SOCCER'),
  game_id: z.string().min(1),
  home_team: z.string().min(1).nullable(),
  away_team: z.string().min(1).nullable(),
  generated_at: isoDateString,
  market_type: z.literal('GAME_TOTAL'),
  line: z.number().nullable(),
  over_price: z.number().int().nullable(),
  under_price: z.number().int().nullable(),
  selection: z.enum(['OVER', 'UNDER']).nullable(),
  edge_basis: z.string().nullable(),
  missing_context_flags: z.array(z.string()),
  pass_reason: z.string().nullable(),
}).passthrough();

const soccerDoubleChanceSchema = z.object({
  sport: z.literal('SOCCER'),
  game_id: z.string().min(1),
  home_team: z.string().min(1).nullable(),
  away_team: z.string().min(1).nullable(),
  generated_at: isoDateString,
  market_type: z.literal('DOUBLE_CHANCE'),
  outcome: z.enum(['home_or_draw', 'away_or_draw', 'either_to_win']).nullable(),
  price: z.number().int().nullable(),
  edge_basis: z.string().nullable(),
  missing_context_flags: z.array(z.string()),
  pass_reason: z.string().nullable(),
}).passthrough();

const ahProbabilitiesSchema = z.object({
  P_win: z.number(),
  P_push: z.number(),
  P_loss: z.number(),
  P_full_win: z.number().optional(),
  P_half_win: z.number().optional(),
  P_half_loss: z.number().optional(),
  P_full_loss: z.number().optional(),
});

function buildSoccerAsianHandicapSchema(expectedSide, expectedCanonicalKey) {
  return z
    .object({
      sport: z.literal('SOCCER'),
      game_id: z.string().min(1),
      home_team: z.string().min(1).nullable(),
      away_team: z.string().min(1).nullable(),
      generated_at: isoDateString,
      canonical_market_key: z.literal(expectedCanonicalKey),
      market_type: z.literal('ASIAN_HANDICAP'),
      side: z.literal(expectedSide),
      line: z.number().nullable(),
      split_flag: z.boolean(),
      price: z.number().int().nullable(),
      opposite_price: z.number().int().nullable(),
      probabilities: ahProbabilitiesSchema.nullable(),
      model_prob_no_push: z.number().nullable(),
      edge_ev: z.number().nullable(),
      expected_value: z.number().nullable(),
      fair_line: z.number().nullable(),
      fair_price_american: z.number().int().nullable(),
      edge_basis: z.string().nullable(),
      missing_context_flags: z.array(z.string()),
      pass_reason: z.string().nullable(),
    })
    .passthrough()
    .superRefine((payload, ctx) => {
      if (payload.pass_reason === null) {
        if (payload.line === null) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['line'],
            message: 'line is required when pass_reason is null',
          });
        }
        if (payload.price === null) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['price'],
            message: 'price is required when pass_reason is null',
          });
        }
        if (payload.probabilities === null) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['probabilities'],
            message: 'probabilities are required when pass_reason is null',
          });
        }
      }

      if (typeof payload.line === 'number' && Number.isFinite(payload.line)) {
        const fraction = Math.abs(payload.line % 1);
        const isQuarter = Math.abs(fraction - 0.25) < 1e-9 || Math.abs(fraction - 0.75) < 1e-9;
        if (isQuarter && payload.split_flag !== true) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['split_flag'],
            message: 'split_flag must be true for quarter lines',
          });
        }
      }
    });
}

const soccerAsianHandicapHomeSchema = buildSoccerAsianHandicapSchema(
  'HOME',
  'asian_handicap_home',
);

const soccerAsianHandicapAwaySchema = buildSoccerAsianHandicapSchema(
  'AWAY',
  'asian_handicap_away',
);

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
  'nhl-totals-call': nhlMarketCallPayloadSchema,
  'nhl-spread-call': nhlMarketCallPayloadSchema,
  'nhl-moneyline-call': nhlMarketCallPayloadSchema,

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
  'soccer': soccerOhioScopeSchema,
  'soccer_ml': soccerMlSchema,
  'soccer_game_total': soccerGameTotalSchema,
  'soccer_double_chance': soccerDoubleChanceSchema,
  'asian_handicap_home': soccerAsianHandicapHomeSchema,
  'asian_handicap_away': soccerAsianHandicapAwaySchema,
  'mlb-model-output': basePayloadSchema,
  'nfl-model-output': basePayloadSchema,
  'fpl-model-output': basePayloadSchema,

  // Legacy aliases retained for backward compatibility.
  // Keep accepted so historical rows remain valid, but no new writes should target deprecated aliases.
  'nhl-model-output': basePayloadSchema, // keep (historical + currently read as NHL evidence card)
  'nba-model-output': basePayloadSchema, // deprecated write alias; kept for historical payloads
  'nhl-welcome-home': driverPayloadSchema, // deprecated alias; canonical replacement is welcome-home-v2
};

// Soccer card types that use self-contained schemas and should skip
// deriveLockedMarketContext (which only handles SPREAD/TOTAL/MONEYLINE contracts
// and does not understand soccer-specific payload shapes).
const SOCCER_SELF_CONTAINED_TYPES = new Set([
  'soccer',
  'soccer_ml',
  'soccer_game_total',
  'soccer_double_chance',
  'asian_handicap_home',
  'asian_handicap_away',
]);

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
    // Soccer self-contained card types use their own validators; skip the
    // deriveLockedMarketContext check which only handles SPREAD/TOTAL/MONEYLINE.
    if (!SOCCER_SELF_CONTAINED_TYPES.has(cardType)) {
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
