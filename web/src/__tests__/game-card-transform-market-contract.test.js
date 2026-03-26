/*
 * Verifies payload-first market inference contract in transform.ts.
 * Run: npm --prefix web run test:transform:market
 */

import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';

const filePath = path.resolve('src/lib/game-card/transform.ts');
const source = fs.readFileSync(filePath, 'utf8');

console.log('🧪 Transform market contract source tests');

assert(
  source.includes('if (play.market_type) {') &&
    source.includes('mapCanonicalToLegacyMarket(play.market_type)'),
  'transform should prioritize payload market_type before all fallbacks',
);

assert(
  source.includes('function isSoccerAsianHandicapPlay(play: ApiPlay): boolean') &&
    source.includes("if (play.market_type === 'PROP')") &&
    source.includes('SOCCER_AH_REMAP_TOKEN'),
  'transform should defensively remap soccer asian handicap rows away from prop flow',
);

assert(
  source.includes('const secondary = inferCanonicalFromSecondary(play);'),
  'transform should use recommended/recommendation fallback before title inference',
);

assert(
  source.includes("reasonCodes.push('LEGACY_TITLE_INFERENCE_USED');"),
  'transform should mark legacy title inference usage explicitly',
);

assert(
  source.includes("reasonCodes.push('PASS_MISSING_MARKET_TYPE');"),
  'transform should attach deterministic pass reason when canonical market is missing',
);

assert(
  source.includes('getRiskTagsFromText') &&
    source.includes("'RISK_FRAGILITY'") &&
    source.includes("'RISK_BLOWOUT'"),
  'risk should be modeled as tags, not as a market bucket',
);

assert(
  source.includes('const resolvedAction = getSourcePlayAction(play);'),
  'transform wave-1 action selection should resolve through shared play action helper',
);

assert(
  source.includes("play.market_type === 'FIRST_PERIOD'"),
  'transform should preserve FIRST_PERIOD market handling for 1P totals cards',
);

assert(
  source.includes("token === 'HOME_OR_DRAW'") &&
    source.includes("token === 'AWAY_OR_DRAW'") &&
    source.includes("token === 'HOME_DNB'") &&
    source.includes("token === 'AWAY_DNB'"),
  'transform should normalize soccer moneyline-family selection sides for display and ranking',
);

assert(
  source.includes("rawSelectionSide === 'HOME_OR_DRAW'") &&
    source.includes("rawSelectionSide === 'AWAY_OR_DRAW'") &&
    source.includes("rawSelectionSide === 'HOME_OR_AWAY'"),
  'transform should treat soccer double-chance and DNB selections as playable moneyline-family bets',
);

assert(
  source.includes("p.market_type === 'PROP' && !isSoccerAsianHandicapPlay(p)"),
  'transform props mode should exclude soccer asian handicap rows even when malformed as PROP',
);

assert(
  source.includes('prop_decision') &&
    source.includes("rawPropDecision?.verdict === 'PLAY'") &&
    source.includes("rawPropDisplayState === 'PROJECTION_ONLY'") &&
    source.includes('market_bookmaker'),
  'transform props mode should prefer canonical prop_decision verdicts and keep prop_display_state as legacy fallback',
);

assert(
  source.includes('const canonicalPropLine =') &&
    source.includes('typeof rawPropDecision?.line === \'number\'') &&
    source.includes('line: canonicalPropLine') &&
    source.includes('marketLine: canonicalPropLine'),
  'transform props mode should prefer prop_decision.line ahead of suggestedLine for canonical threshold display semantics',
);

assert(
  source.includes('PROP_VERDICT_RANK') &&
    source.includes('b.probEdgePp') &&
    source.includes('b.lineDelta') &&
    source.includes("a.propVerdict === 'NO_PLAY' && b.propVerdict === 'NO_PLAY'") &&
    source.includes('Math.abs(a.lineDelta'),
  'transform props mode should sort by verdict rank, preserve stronger no-play gaps, then probEdgePp and lineDelta',
);

assert(
  source.includes("canonicalMarketKey === 'pitcher_strikeouts' || titleLower.includes('strikeout')") &&
    source.includes("propType = 'Strikeouts'"),
  'transform props mode should classify pitcher_strikeouts canonical_market_key as Strikeouts propType',
);

console.log('✅ Transform market contract source tests passed');
