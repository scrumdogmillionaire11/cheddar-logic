/*
 * Verifies payload-first market inference contract in transform/index.ts.
 * Run: npm --prefix web run test:transform:market
 */

import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../..',
);
const filePath = path.resolve(
  repoRoot,
  'web/src/lib/game-card/transform/index.ts',
);
const source = fs.readFileSync(filePath, 'utf8');
const gameCardSource = fs.readFileSync(
  path.resolve(repoRoot, 'web/src/components/cards/GameCardItem.tsx'),
  'utf8',
);
const propGameCardSource = fs.readFileSync(
  path.resolve(repoRoot, 'web/src/components/prop-game-card.tsx'),
  'utf8',
);
const titleInferenceSource = fs.readFileSync(
  path.resolve(repoRoot, 'web/src/lib/game-card/transform/title-inference.ts'),
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

// PROJECTION_ONLY prop plays are intentionally kept in the prop plays list so the
// Player Props tab is non-empty during daytime model runs (no live prop prices).
// They are downgraded to propVerdict='PROJECTION' / status='NO_PLAY' via
// normalizePropVerdict → isProjectionOnlyPropPlay rather than filtered out here.
// Game-line surfaces still exclude them via isProjectionOnlyCardPlay guards.
assert(
  source.includes('isProjectionOnlyPropPlay(play, propDecision)') &&
    source.includes('!isProjectionOnlyCardPlay(play) &&') &&
    source.includes('!isProjectionOnlyCardPlay(game.true_play)'),
  'transform: game-line surfaces exclude projection-only rows; props surface downgrades them to propVerdict=PROJECTION via isProjectionOnlyPropPlay',
);

assert(
  source.includes('const rawPropDecision = play.prop_decision;') &&
    source.includes('const propVerdict = normalizePropVerdict(play, rawPropDecision);') &&
    source.includes("play.prop_display_state === 'PROJECTION_ONLY'") &&
    source.includes('market_bookmaker'),
  'transform props mode should resolve canonical prop_decision verdicts through normalizePropVerdict and keep prop_display_state as fallback',
);

assert(
  source.includes('const fromPayload = play.player_name;') &&
    source.includes('if (fromPayload && !isPlaceholderPlayerName(fromPayload))') &&
    source.includes('const selectionTeam = play.selection?.team;') &&
    source.includes('if (selectionTeam && !isPlaceholderPlayerName(selectionTeam))'),
  'transform props mode should infer player_name from payload before falling back to selection.team',
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
    source.includes("typeof rawPropDecision?.k_mean === 'number'") &&
    source.includes("typeof rawPropDecision?.projection === 'number'") &&
    source.includes('const mu = canonicalPropProjection;') &&
    source.includes('projection: canonicalPropProjection'),
  'transform props mode should prefer prop_decision.k_mean / prop_decision.projection as the canonical numeric projection for display',
);

assert(
  source.includes("play.basis === 'PROJECTION_ONLY'") &&
    source.includes("play.execution_status === 'PROJECTION_ONLY'") &&
    source.includes("play.prop_display_state === 'PROJECTION_ONLY'") &&
    source.includes("projectionSource === 'SYNTHETIC_FALLBACK'") &&
    source.includes("if (rawVerdict === 'PASS')") &&
    source.includes("return 'PROJECTION';"),
  'transform should identify projection-only rows via basis, execution_status, prop_display_state, and synthetic fallback provenance',
);

assert(
  source.includes('const probabilityLadder =') &&
    source.includes('const fairPrices =') &&
    source.includes('const playability =') &&
    source.includes('const projectionSource =') &&
    source.includes('const statusCap =') &&
    source.includes('const passReasonCode =') &&
    source.includes('const passReason =') &&
    source.includes('kMean,') &&
    source.includes('probabilityLadder,') &&
    source.includes('fairPrices,') &&
    source.includes('missingInputs,'),
  'transform props mode should preserve MLB pitcher K ladder, fair prices, playability, provenance, and PASS metadata',
);

assert(
  source.includes('projection_source?: ProjectionSource | null;') &&
    source.includes('status_cap?: StatusCap | null;') &&
    source.includes('projected_total_low?: number | null;') &&
    source.includes('projectionSource: sourcePlay?.projection_source ?? undefined') &&
    source.includes('statusCap: sourcePlay?.status_cap ?? undefined') &&
    source.includes('playability: sourcePlay?.playability ?? undefined'),
  'transform game-line mode should preserve MLB F5 projection provenance and playable range metadata',
);

assert(
  gameCardSource.includes("const isF5TotalMarket = card.sport === 'MLB' && marketType === 'FIRST_PERIOD';") &&
    gameCardSource.includes('const projectionSourceLabel =') &&
    gameCardSource.includes("displayPlay.projectionSource === 'DEGRADED_MODEL'") &&
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
  propGameCardSource.includes('const isProjectionOnlyProp = (prop: PropPlayRow) =>') &&
    propGameCardSource.includes('Model Projection \\u2014 No Line Applied') &&
    propGameCardSource.includes('PITCHER_K_THRESHOLDS') &&
    propGameCardSource.includes('Fair O') &&
    propGameCardSource.includes('Over at {formatNumber(prop.playability?.over_playable_at_or_below, 1)} or lower') &&
    propGameCardSource.includes('Standard line:') &&
    propGameCardSource.includes('PASS reason:') &&
    propGameCardSource.includes('getSourceBadgeClass') &&
    propGameCardSource.includes('getStatusCapBadgeClass'),
  'PropGameCard should render pitcher K ladders/fair odds, playable thresholds, source/cap badges, PASS diagnostics, and model-only fallback copy',
);

assert(
  source.includes("canonicalMarketKey === 'player_blocked_shots'") &&
    source.includes("titleLower.includes('blocked shots') || play.cardType === 'nhl-player-blk'") &&
    source.includes("propType = 'Blocked Shots'"),
  'transform props mode should classify blocked-shot payloads from canonical market or nhl-player-blk card type',
);

console.log('✅ Transform market contract source tests passed');
