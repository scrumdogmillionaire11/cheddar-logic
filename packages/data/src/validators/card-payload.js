/**
 * Card Payload Validation
 *
 * CONTRACT — Write path:
 *   Worker jobs (run_nhl_model, run_nhl_player_shots_model, etc.)
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
 *   server/model-outputs, /api/models/*, /api/betting/projections
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

const mlbPitcherKAltLineSchema = z.object({
  line: z.number(),
  side: z.enum(['over', 'under']),
  juice: z.number().int().nullable().optional(),
  book: z.string().nullable().optional(),
  source: z.string().nullable().optional(),
  captured_at: z.string().nullable().optional(),
});

const mlbPitcherKLineContractSchema = z
  .object({
    line: z.number().nullable().optional(),
    over_price: z.number().int().nullable().optional(),
    under_price: z.number().int().nullable().optional(),
    bookmaker: z.string().nullable().optional(),
    line_source: z.string().nullable().optional(),
    opening_line: z.number().nullable().optional(),
    opening_over_price: z.number().int().nullable().optional(),
    opening_under_price: z.number().int().nullable().optional(),
    best_available_line: z.number().nullable().optional(),
    best_available_over_price: z.number().int().nullable().optional(),
    best_available_under_price: z.number().int().nullable().optional(),
    best_available_bookmaker: z.string().nullable().optional(),
    current_timestamp: z.string().nullable().optional(),
    alt_lines: z.array(mlbPitcherKAltLineSchema).optional(),
  })
  .passthrough();

// ============================================================================
// MLB Pitcher K schema
// ============================================================================
// Card type: 'mlb-pitcher-k'
// canonical_market_key: 'pitcher_strikeouts'
// Current runtime: run_mlb_model.js emits PROJECTION_ONLY only (WI-0733).
// ODDS_BACKED remains accepted for historical payload compatibility only.
//
// Contract (docs/pitcher_ks/07output.md):
//   - basis: 'PROJECTION_ONLY' | 'ODDS_BACKED'
//   - player_name: '<TEAM> SP'
//   - canonical_market_key: 'pitcher_strikeouts'
//   - pitcher_k_result: null | object (engine signal diagnostics)
//   - tags: string[] (may include 'no_odds_mode', 'HIGH VIG', etc.)
//   - pitcher_k_line_contract: dormant ODDS_BACKED line contract (standard + alt)
// ============================================================================

const mlbPitcherKPayloadSchema = z
  .object({
    game_id: z.string().min(1),
    sport: z.literal('MLB'),
    model_version: z.string().min(1),
    home_team: z.string().min(1).nullable(),
    away_team: z.string().min(1).nullable(),
    matchup: z.string().nullable().optional(),
    start_time_utc: z.string().nullable().optional(),
    market_type: z.literal('PROP'),
    prediction: z.string().min(1),
    selection: z.object({
      side: z.string().min(1),
    }),
    line: z.number().nullable(),
    confidence: z.number().min(0).max(1),
    status: z.enum(['FIRE', 'WATCH', 'PASS']).optional(),
    action: z.enum(['FIRE', 'HOLD', 'PASS']).optional(),
    classification: z.enum(['BASE', 'LEAN', 'PASS']).optional(),
    tier: z.enum(['BEST', 'WATCH']).nullable().optional(),
    ev_passed: z.boolean(),
    reasoning: z.string().nullable().optional(),
    reason_codes: z.array(z.string()).optional(),
    pass_reason_code: z.string().nullable().optional(),
    projection_source: z.enum([
      'FULL_MODEL',
      'DEGRADED_MODEL',
      'SYNTHETIC_FALLBACK',
    ]).nullable().optional(),
    status_cap: z.enum(['PLAY', 'LEAN', 'PASS']).nullable().optional(),
    playability: z
      .object({
        over_playable_at_or_below: z.number().nullable().optional(),
        under_playable_at_or_above: z.number().nullable().optional(),
      })
      .nullable()
      .optional(),
    missing_inputs: z.array(z.string()).optional(),
    projection: z
      .object({
        k_mean: z.number().nullable().optional(),
        projected_ip: z.number().nullable().optional(),
        bf_exp: z.number().nullable().optional(),
        batters_per_inning: z.number().nullable().optional(),
        k_interaction: z.number().nullable().optional(),
        k_leash_mult: z.number().nullable().optional(),
        starter_k_pct: z.number().nullable().optional(),
        starter_swstr_pct: z.number().nullable().optional(),
        whiff_proxy_pct: z.number().nullable().optional(),
        opp_k_pct_vs_hand: z.number().nullable().optional(),
        probability_ladder: z
          .object({
            p_5_plus: z.number().nullable().optional(),
            p_6_plus: z.number().nullable().optional(),
            p_7_plus: z.number().nullable().optional(),
          })
          .nullable()
          .optional(),
        fair_prices: z.record(z.unknown()).nullable().optional(),
      })
      .nullable()
      .optional(),
    disclaimer: z.string().optional(),
    generated_at: isoDateString,
    player_name: z.string().min(1),
    canonical_market_key: z.literal('pitcher_strikeouts'),
    basis: z.enum(['PROJECTION_ONLY', 'ODDS_BACKED']),
    tags: z.array(z.string()).optional(),
    pitcher_k_result: z.unknown().nullable().optional(),
    // Odds-backed mode enrichment (optional — absent in PROJECTION_ONLY)
    line_source: z.string().nullable().optional(),
    over_price: z.number().int().nullable().optional(),
    under_price: z.number().int().nullable().optional(),
    best_line_bookmaker: z.string().nullable().optional(),
    margin: z.number().nullable().optional(),
    // Diagnostics (optional — populated on fail-closed paths)
    ingest_failure_reason_code: z.string().nullable().optional(),
    // Dormant odds-backed market contract; must stay null in PROJECTION_ONLY runtime.
    pitcher_k_line_contract: mlbPitcherKLineContractSchema.nullable().optional(),
  })
  .passthrough()
  .superRefine((payload, ctx) => {
    // ODDS_BACKED cards must carry a line and line_source
    if (payload.basis === 'ODDS_BACKED') {
      if (payload.line === null || payload.line === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['line'],
          message: 'ODDS_BACKED pitcher_k card must have a numeric line',
        });
      }
      if (!payload.line_source) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['line_source'],
          message: 'ODDS_BACKED pitcher_k card must have line_source set',
        });
      }
      if (
        payload.pitcher_k_line_contract &&
        payload.pitcher_k_line_contract.line == null
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['pitcher_k_line_contract', 'line'],
          message: 'ODDS_BACKED pitcher_k card line contract must have line set',
        });
      }
    }
    // PROJECTION_ONLY cards must carry the 'no_odds_mode' tag
    if (payload.basis === 'PROJECTION_ONLY') {
      const tags = payload.tags || [];
      if (!tags.includes('no_odds_mode')) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['tags'],
          message: "PROJECTION_ONLY pitcher_k card must include 'no_odds_mode' in tags",
        });
      }
      const status = String(payload.status || '').toUpperCase();
      const action = String(payload.action || '').toUpperCase();
      const classification = String(payload.classification || '').toUpperCase();
      if (status && status !== 'PASS') {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['status'],
          message: 'PROJECTION_ONLY pitcher_k card must have status=PASS',
        });
      }
      if (action && action !== 'PASS') {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['action'],
          message: 'PROJECTION_ONLY pitcher_k card must have action=PASS',
        });
      }
      if (classification && classification !== 'PASS') {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['classification'],
          message: 'PROJECTION_ONLY pitcher_k card must have classification=PASS',
        });
      }
      if (payload.ev_passed !== false) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['ev_passed'],
          message: 'PROJECTION_ONLY pitcher_k card must have ev_passed=false',
        });
      }
      if (payload.line !== null && payload.line !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['line'],
          message: 'PROJECTION_ONLY pitcher_k card must have line=null',
        });
      }
      if (payload.tier !== null && payload.tier !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['tier'],
          message: 'PROJECTION_ONLY pitcher_k card must not set tier',
        });
      }
      if (payload.status_cap && payload.status_cap !== 'PASS') {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['status_cap'],
          message: 'PROJECTION_ONLY pitcher_k card must cap at PASS',
        });
      }
      for (const key of ['line_source', 'over_price', 'under_price', 'best_line_bookmaker', 'margin']) {
        if (payload[key] !== null && payload[key] !== undefined) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [key],
            message: `PROJECTION_ONLY pitcher_k card must have ${key}=null`,
          });
        }
      }
      if (payload.pitcher_k_line_contract !== null && payload.pitcher_k_line_contract !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['pitcher_k_line_contract'],
          message: 'PROJECTION_ONLY pitcher_k card must not carry pitcher_k_line_contract',
        });
      }
    }
  });

const mlbF5PayloadSchema = basePayloadSchema
  .extend({
    game_id: z.string().min(1),
    sport: z.literal('MLB'),
    model_version: z.string().min(1),
    home_team: z.string().min(1).nullable(),
    away_team: z.string().min(1).nullable(),
    market_type: z.literal('FIRST_PERIOD'),
    selection: z.object({
      side: z.enum(['OVER', 'UNDER']),
    }),
    line: z.number().nullable(),
    status: z.enum(['FIRE', 'WATCH', 'PASS']).optional(),
    action: z.enum(['FIRE', 'HOLD', 'PASS']).optional(),
    classification: z.enum(['BASE', 'LEAN', 'PASS']).optional(),
    tier: z.enum(['BEST', 'WATCH']).nullable().optional(),
    ev_passed: z.boolean(),
    projection_source: z.enum([
      'FULL_MODEL',
      'DEGRADED_MODEL',
      'SYNTHETIC_FALLBACK',
    ]),
    status_cap: z.enum(['PLAY', 'LEAN', 'PASS']).nullable().optional(),
    projection: z.object({
      projected_total: z.number(),
      projected_total_low: z.number().nullable().optional(),
      projected_total_high: z.number().nullable().optional(),
      projected_home_f5_runs: z.number().nullable().optional(),
      projected_away_f5_runs: z.number().nullable().optional(),
    }).passthrough(),
    playability: z
      .object({
        over_playable_at_or_below: z.number().nullable().optional(),
        under_playable_at_or_above: z.number().nullable().optional(),
      })
      .nullable()
      .optional(),
    missing_inputs: z.array(z.string()),
    reason_codes: z.array(z.string()).optional(),
    pass_reason_code: z.string().nullable().optional(),
    primary_game_market: z.boolean().optional(),
    chosen_market: z.string().optional(),
    why_this_market: z.string().optional(),
  })
  .passthrough()
  .superRefine((payload, ctx) => {
    if (payload.projection_source === 'SYNTHETIC_FALLBACK') {
      const status = String(payload.status || '').toUpperCase();
      const action = String(payload.action || '').toUpperCase();
      if (status !== 'PASS') {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['status'],
          message: 'SYNTHETIC_FALLBACK mlb-f5 payload must have status=PASS',
        });
      }
      if (action !== 'PASS') {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['action'],
          message: 'SYNTHETIC_FALLBACK mlb-f5 payload must have action=PASS',
        });
      }
      if (payload.ev_passed !== false) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['ev_passed'],
          message: 'SYNTHETIC_FALLBACK mlb-f5 payload must have ev_passed=false',
        });
      }
    }
    if (payload.projection_source === 'DEGRADED_MODEL') {
      const status = String(payload.status || '').toUpperCase();
      if (status === 'FIRE') {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['status'],
          message: 'DEGRADED_MODEL mlb-f5 payload must not have status=FIRE',
        });
      }
      if (payload.status_cap && payload.status_cap !== 'LEAN') {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['status_cap'],
          message: 'DEGRADED_MODEL mlb-f5 payload must cap at LEAN',
        });
      }
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
  'welcome-home': driverPayloadSchema,
  'welcome-home-v2': driverPayloadSchema, // alias: backward compat with existing DB rows

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

  // Active MLB prop cards
  'mlb-pitcher-k': mlbPitcherKPayloadSchema,

  // Active MLB game/model output cards
  'mlb-model-output': basePayloadSchema,
  'mlb-strikeout': basePayloadSchema,
  'mlb-f5': mlbF5PayloadSchema,
  'mlb-f5-ml': basePayloadSchema,
  'nfl-model-output': basePayloadSchema,
  'fpl-model-output': basePayloadSchema,

  // Legacy aliases retained for backward compatibility.
  // Keep accepted so historical rows remain valid, but no new writes should target deprecated aliases.
  'nhl-model-output': basePayloadSchema, // keep (historical + currently read as NHL evidence card)
  'nba-model-output': basePayloadSchema, // deprecated write alias; kept for historical payloads
  'nhl-welcome-home': driverPayloadSchema, // deprecated alias; canonical replacement is welcome-home-v2
};

// Card types that use self-contained schemas and should skip
// deriveLockedMarketContext (which only handles SPREAD/TOTAL/MONEYLINE contracts
// and does not understand MLB prop payload shapes).
const MARKET_CONTRACT_BYPASS_TYPES = new Set([
  // MLB prop cards — PROP market_type bypasses standard SPREAD/TOTAL/ML contract
  'mlb-pitcher-k',
  'mlb-strikeout',
  'mlb-f5',
  'mlb-f5-ml',
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
    if (!MARKET_CONTRACT_BYPASS_TYPES.has(cardType)) {
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
