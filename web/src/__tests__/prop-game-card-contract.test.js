/*
 * Verifies the NHL props decision-first UI contract in prop-game-card.tsx.
 */

import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';

const filePath = path.resolve('web/src/components/prop-game-card.tsx');
const source = fs.readFileSync(filePath, 'utf8');

console.log('🧪 Prop game card contract source tests');

assert(
  source.includes('showEdgeBox') &&
    source.includes("{showEdgeBox && (") &&
    source.includes('Fair:') &&
    source.includes('Implied:'),
  'prop-game-card should hide the entire Edge box when market math is unavailable',
);

assert(
  source.includes('buildHeroLine') &&
    source.includes('NO PLAY${closeTag} —') &&
    source.includes("' (Close)'") &&
    source.includes('getNoPlayLeanStrength') &&
    source.includes('getThresholdOutcomeText') &&
    source.includes('or fewer ${units.plural}') &&
    source.includes('${resolvedTarget}+ ${resolvedTarget === 1 ? units.singular : units.plural}') &&
    source.includes("return 'Strong';") &&
    source.includes("return 'Weak';"),
  'prop-game-card should render threshold-market hero copy and differentiate strong vs weak non-play leans',
);

assert(
  source.includes('projectionLead') &&
    source.includes('Projection: ${formatNumber(projectionValue)} ${getPropUnits(prop.propType).plural}') &&
    source.includes('getHitRateLabel') &&
    source.includes('Hit rate (') &&
    source.includes('Win condition: ${thresholdOutcomeText}') &&
    !source.includes('vs line'),
  'prop-game-card should render projection and side-aware threshold hit rate prominently without totals-style vs-line copy',
);

assert(
  source.includes("const getPropUnits = (propType: string | null | undefined) => {") &&
    source.includes("return { singular: 'block', plural: 'blocks' };") &&
    source.includes('getPropUnits(prop.propType).plural'),
  'prop-game-card should use blocked-shot-specific block/blocks wording instead of hard-coded shots labels',
);

assert(
  source.includes('const lineValue = prop.marketLine ?? prop.line ?? prop.suggestedLine;'),
  'prop-game-card should use the canonical market line before suggestedLine when building threshold copy',
);

assert(
  source.includes('getL5RelativeText') &&
    source.includes('above ${thresholdText}') &&
    source.includes('below ${thresholdText}') &&
    source.includes('near ${thresholdText}'),
  'prop-game-card should explain L5 relative to the threshold, not just as a raw trend label',
);

assert(
  source.includes('getDeterministicExplanation') &&
    source.includes("uniqueFlags.includes('PROJECTION_CONFLICT')") &&
    source.includes('Projection supports ${outcomeText}, but price (${priceText}) is too expensive') &&
    source.includes('Projection sits near the ${outcomeText} threshold — no edge') &&
    source.includes('Market is efficient for ${outcomeText} at ${priceText}') &&
    !source.includes('No prop reason available.'),
  'prop-game-card should render deterministic threshold-aware explanation text for every card without generic placeholders or projection-conflict fallthrough',
);

assert(
  source.includes('getWatchlistTrigger') &&
    source.includes("includes('PROJECTION_CONFLICT')") &&
    source.includes('Would be PLAY at ${formatOdds(targetPrice)} or better') &&
    source.includes('Playable at ${formatOdds(targetPrice)} or better') &&
    source.includes('Bet if the threshold drops to') &&
    source.includes('Bet if the threshold rises to'),
  'prop-game-card should render deterministic price or threshold triggers when a real better number would flip the row',
);

assert(
  source.includes('Book: {formatBookName(prop.bookmaker)}'),
  'prop-game-card should surface available sportsbook source context in the market box',
);

assert(
  source.includes('getNoPlayLeanContext') &&
    source.includes('No directional edge') &&
    source.includes('Even distribution — no lean') &&
    !source.includes('Flat lean'),
  'prop-game-card should replace flat-lean copy with sharper deterministic non-edge wording',
);

// WI-0663: ODDS_BACKED pitcher-K rows with WATCH/PLAY verdict must render as actionable (not PROJECTION)
// The isProjectionOnlyProp check must not downgrade ODDS_BACKED rows based on basis alone
assert(
  source.includes("prop.propVerdict === 'WATCH'") ||
    source.includes("prop.propVerdict !== 'PROJECTION'") ||
    (
      source.includes('isProjectionOnlyProp') &&
      source.includes("'PROJECTION_ONLY'")
    ),
  'prop-game-card should not downgrade ODDS_BACKED pitcher-K WATCH/PLAY rows to PROJECTION — only PROJECTION_ONLY rows are non-actionable',
);

console.log('✅ Prop game card contract source tests passed');
