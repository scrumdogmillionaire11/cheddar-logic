/*
 * Verifies soccer market alias/repair handling in /api/games source.
 * Run: node web/src/__tests__/api-games-soccer-market-contract.test.js
 */

import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
const __dirname = new URL('.', import.meta.url).pathname.replace(/\/$/, '');

const routePath = path.resolve(__dirname, '../../src/app/api/games/route.ts');
const source = fs.readFileSync(routePath, 'utf8');

console.log('🧪 /api/games soccer market contract source tests');

assert(
  source.includes("if (upper === 'GAME_TOTAL') return 'TOTAL';"),
  '/api/games should normalize GAME_TOTAL payloads into TOTAL for UI compatibility',
);

assert(
  source.includes('isSoccerAsianHandicapPayload({') &&
    source.includes("const normalizedMarketType =") &&
    source.includes("? 'SPREAD' : normalizedMarketTypeRaw"),
  '/api/games should force soccer Asian handicap payloads onto SPREAD market_type',
);

assert(
  source.includes('const ahRemappedFromProp =') &&
    source.includes('SOCCER_AH_REMAP_TOKEN') &&
    source.includes('combinedReasonCodes.push(SOCCER_AH_REMAP_TOKEN);'),
  '/api/games should emit deterministic AH remap diagnostics when malformed payloads arrive as PROP',
);

assert(
  source.includes("upper === 'DOUBLE_CHANCE' || upper === 'DOUBLECHANCE'") &&
    source.includes("upper === 'DRAW_NO_BET' || upper === 'DRAWNOBET'"),
  '/api/games should normalize soccer moneyline-family aliases into supported UI markets',
);

assert(
  source.includes("(payload as Record<string, unknown>).outcome") &&
    source.includes("(payload as Record<string, unknown>).selection"),
  '/api/games should recover soccer selection side from direct payload selection/outcome fields',
);

assert(
  source.includes("(payload as Record<string, unknown>).over_price") &&
    source.includes("(payload as Record<string, unknown>).under_price"),
  '/api/games should recover soccer total prices from over_price/under_price payload fields',
);

assert(
  source.includes("normalized.includes('double_chance')") &&
    source.includes("return 'MONEYLINE';"),
  '/api/games should infer soccer double-chance card types as moneyline-family plays when needed',
);

console.log('✅ /api/games soccer market contract source tests passed');
