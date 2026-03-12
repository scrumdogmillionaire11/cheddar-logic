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

console.log('✅ Transform market contract source tests passed');
