/*
 * Source-contract checks for NCAAM FT advantage callout on cards.
 * Run: node src/__tests__/cards-ft-advantage-source.test.js
 */

import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
const __dirname = new URL('.', import.meta.url).pathname.replace(/\/$/, '');

const cardsPagePath = fs.existsSync(
  path.resolve('src/components/cards-page-client.tsx'),
)
  ? path.resolve('src/components/cards-page-client.tsx')
  : path.resolve(__dirname, '../../src/components/cards-page-client.tsx');

const cardsPageSource = fs.readFileSync(cardsPagePath, 'utf8');
const routePath = fs.existsSync(path.resolve('src/app/api/games/route.ts'))
  ? path.resolve('src/app/api/games/route.ts')
  : path.resolve(__dirname, '../../src/app/api/games/route.ts');
const routeSource = fs.readFileSync(routePath, 'utf8');
const transformPath = fs.existsSync(path.resolve('src/lib/game-card/transform.ts'))
  ? path.resolve('src/lib/game-card/transform.ts')
  : path.resolve(__dirname, '../../src/lib/game-card/transform.ts');
const transformSource = fs.readFileSync(transformPath, 'utf8');

console.log('NCAAM FT advantage source-contract checks');

assert(
  cardsPageSource.includes("driver.cardType === 'ncaam-ft-trend'"),
  'cards-page-client must scan for ncaam-ft-trend driver',
);
assert(
  cardsPageSource.includes('FT context:') ||
    cardsPageSource.includes('FT Advantage:') ||
    cardsPageSource.includes('FT Trend Play:'),
  'cards-page-client must render FT label (FT context: / FT Advantage: / FT Trend Play:) in Why section',
);
assert(
  cardsPageSource.includes('formatFtTrendInsight('),
  'cards-page-client must format FT trend insight text',
);
assert(
  cardsPageSource.includes('const sideFromPct ='),
  'cards-page-client must derive FT side from FT percentage values first',
);
assert(
  cardsPageSource.includes('context?.advantagedSide'),
  'cards-page-client must support explicit advantaged side context fallback',
);
assert(
  cardsPageSource.includes("card.sport === 'NCAAM' && displayPlay.market_type === 'SPREAD'"),
  'cards-page-client must only render FT advantage on NCAAM spread plays',
);
assert(
  cardsPageSource.includes('const shouldRenderSpreadContext = hasSpreadContext && !isFtTrendSpread;'),
  'cards-page-client must suppress spread projection math for FT trend cards',
);
assert(
  routeSource.includes('ft_trend_context'),
  'games route must expose ft_trend_context in play payloads',
);
assert(
  routeSource.includes('driverInputs?.home_ft_pct'),
  'games route must hydrate FT context from driver inputs',
);
assert(
  transformSource.includes('ft_trend_context'),
  'game-card transform must accept ft_trend_context from API plays',
);
assert(
  transformSource.includes('ftTrendContext:'),
  'game-card transform must map ft_trend_context into driver rows',
);

console.log('NCAAM FT advantage source-contract checks passed');
