/*
 * Verifies payload-first market inference contract in transform/index.ts.
 * Run: npm --prefix web run test:transform:market
 */

import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';

const filePath = path.resolve('web/src/lib/game-card/transform/index.ts');
const source = fs.readFileSync(filePath, 'utf8');
const gameCardSource = fs.readFileSync(
  path.resolve('web/src/components/cards/GameCardItem.tsx'),
  'utf8',
);
const titleInferenceSource = fs.readFileSync(
  path.resolve('web/src/lib/game-card/transform/title-inference.ts'),
  'utf8',
);

console.log('🧪 Transform market contract source tests');

assert(
  source.includes("const marketType = wave1DecisionPlay.market_type ?? 'INFO';") &&
    source.includes('mapCanonicalToLegacyMarket(marketType)'),
  'transform should prioritize payload market_type before all fallbacks',
);

assert(
  source.includes("const propPlay = scopedPlayCandidates.find(") &&
    source.includes("(p) => p.market_type === 'PROP' && p.confidence >= 0.0"),
  'transform should check canonical PROP plays before falling back to game-line market selection',
);

assert(
  source.includes("reasonCodes.push('PASS_MISSING_MARKET_TYPE');"),
  'transform should attach deterministic pass reason when canonical market is missing',
);

assert(
  source.includes('getRiskTagsFromText') &&
    titleInferenceSource.includes("tags.push('RISK_FRAGILITY')") &&
    titleInferenceSource.includes("tags.push('RISK_BLOWOUT')"),
  'risk should be modeled as tags, not as a market bucket',
);

assert(
  source.includes('const action = getSourcePlayAction(play);') &&
    source.includes('const sourceAction = getSourcePlayAction(sourcePlay);'),
  'transform wave-1 action selection should resolve through shared play action helper',
);

assert(
  source.includes("canonical === 'FIRST_PERIOD'"),
  'transform should preserve FIRST_PERIOD market handling for 1P totals cards',
);

assert(
  !source.includes('isSoccerAsianHandicapPlay') &&
    !source.includes('HOME_OR_DRAW') &&
    !source.includes('AWAY_OR_DRAW') &&
    !source.includes('HOME_DNB') &&
    !source.includes('AWAY_DNB'),
  'transform should not retain soccer-specific market or selection remap branches',
);

assert(
  source.includes("const propPlays = game.plays.filter((p) => p.market_type === 'PROP');"),
  'transform props mode should scope prop rows by canonical PROP market only',
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
  source.includes('const canonicalPropProjection =') &&
    source.includes("typeof rawPropDecision?.projection === 'number'") &&
    source.includes('const mu = canonicalPropProjection;') &&
    source.includes('projection: canonicalPropProjection'),
  'transform props mode should prefer prop_decision.projection as the canonical numeric projection for display',
);

assert(
  source.includes('projection_source?: \'FULL_MODEL\' | \'SYNTHETIC_FALLBACK\' | null;') &&
    source.includes('projected_total_low?: number | null;') &&
    source.includes('projectionSource: sourcePlay?.projection_source ?? undefined') &&
    source.includes('playability: sourcePlay?.playability ?? undefined'),
  'transform game-line mode should preserve MLB F5 projection provenance and playable range metadata',
);

assert(
  gameCardSource.includes("const isF5TotalMarket = card.sport === 'MLB' && marketType === 'FIRST_PERIOD';") &&
    gameCardSource.includes('const projectionSourceLabel =') &&
    gameCardSource.includes('Playable O&lt;=') &&
    gameCardSource.includes('Team means:') &&
    gameCardSource.includes("displayPlay.projectionSource === 'SYNTHETIC_FALLBACK'"),
  'GameCardItem should render MLB F5 source, range, team means, and playable thresholds',
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

assert(
  source.includes("canonicalMarketKey === 'player_blocked_shots'") &&
    source.includes("titleLower.includes('blocked shots') || play.cardType === 'nhl-player-blk'") &&
    source.includes("propType = 'Blocked Shots'"),
  'transform props mode should classify blocked-shot payloads from canonical market or nhl-player-blk card type',
);

console.log('✅ Transform market contract source tests passed');
