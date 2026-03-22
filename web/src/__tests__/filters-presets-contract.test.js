/*
 * Source-contract checks for all filter presets, sort defaults, and filterByCardType fix.
 * Run: node src/__tests__/filters-presets-contract.test.js
 */

import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
const __dirname = new URL('.', import.meta.url).pathname.replace(/\/$/, '');

function resolveSrc(rel) {
  const direct = path.resolve('src', rel);
  const nested = path.resolve(__dirname, '../../src', rel);
  return fs.existsSync(direct) ? direct : nested;
}

const presetsSource = fs.readFileSync(resolveSrc('lib/game-card/presets.ts'), 'utf8');
const filtersSource = fs.readFileSync(resolveSrc('lib/game-card/filters.ts'), 'utf8');

console.log('🧪 Filter presets + sort + FT-trend source-contract checks');

// ─── Default sort ──────────────────────────────────────────────────────────
assert(
  filtersSource.includes("sortMode: 'start_time'"),
  'DEFAULT_GAME_FILTERS must default sortMode to start_time',
);

// start_time sort must be pure chronological — no FIRE-first bias
assert(
  !filtersSource.includes("// Special handling for start_time sort: FIRE first"),
  'start_time sort must not insert FIRE-first priority — pure start_time order',
);
assert(
  !filtersSource.includes("sortMode === 'start_time'") ||
    !filtersSource.includes('aIsFire && !bIsFire'),
  'start_time sort must not promote FIRE cards ahead of chronological order',
);

// ─── play_tonight must NOT exist ──────────────────────────────────────────
assert(
  !presetsSource.includes("id: 'play_tonight'"),
  'play_tonight preset must be removed',
);

// ─── 1p_totals must NOT exist ─────────────────────────────────────────────
assert(
  !presetsSource.includes("id: '1p_totals'"),
  '1p_totals preset must be removed',
);

// ─── Watch List (watch_next_4h): slight edges only within 4h ──────────────
assert(
  presetsSource.includes("id: 'watch_next_4h'"),
  'watch_next_4h preset must exist',
);
{
  // Extract just the watch_next_4h block to scope assertions
  const watchIdx = presetsSource.indexOf("id: 'watch_next_4h'");
  const watchBlock = presetsSource.slice(watchIdx, watchIdx + 600);

  assert(
    watchBlock.includes("statuses: ['WATCH'] as ExpressionStatus[]"),
    'watch_next_4h must only include WATCH (slight edges), not FIRE',
  );
  assert(
    watchBlock.includes("timeWindow: 'custom'"),
    'watch_next_4h must use custom time window',
  );
  assert(
    watchBlock.includes('4 * 60 * 60 * 1000'),
    'watch_next_4h window must be 4 hours',
  );
}

// ─── Starting Soon (next_2h): all games within 2h including no plays ──────
assert(
  presetsSource.includes("id: 'next_2h'"),
  'next_2h preset must exist',
);
{
  const next2hIdx = presetsSource.indexOf("id: 'next_2h'");
  const next2hBlock = presetsSource.slice(next2hIdx, next2hIdx + 400);

  assert(
    next2hBlock.includes('statuses: FIRE_WATCH_PASS'),
    'next_2h must include PASS status (no-play games)',
  );
  assert(
    next2hBlock.includes("timeWindow: 'next_2h'"),
    'next_2h must use next_2h time window',
  );
  assert(
    next2hBlock.includes("sortMode: 'start_time'"),
    'next_2h must sort by start time',
  );
}

// ─── Play Tier Only (best_only): FIRE only, no WATCH, no time restriction ─
assert(
  presetsSource.includes("id: 'best_only'"),
  'best_only preset must exist',
);
{
  const bestIdx = presetsSource.indexOf("id: 'best_only'");
  const bestBlock = presetsSource.slice(bestIdx, bestIdx + 400);

  assert(
    bestBlock.includes('statuses: FIRE_ONLY'),
    'best_only must only include FIRE status (no slight edges)',
  );
  assert(
    !bestBlock.includes("timeWindow: 'today'"),
    'best_only must not restrict to today (allows tomorrow)',
  );
  assert(
    !bestBlock.includes("timeWindow: 'next_2h'"),
    'best_only must not restrict to next 2h',
  );
}

// ─── FT Trend: filterByCardType checks ALL drivers ────────────────────────
assert(
  filtersSource.includes('card.drivers.some((d) => filters.cardTypes!.includes(d.cardType ?? \'\'))'),
  'filterByCardType must check all drivers, not just drivers[0]',
);
assert(
  !filtersSource.includes("card.drivers[0]?.cardType"),
  'filterByCardType must not rely on first driver only',
);

// ─── FT trend preset still targets correct card types ─────────────────────
assert(
  presetsSource.includes("id: 'ncaam_ft_trend'"),
  'ncaam_ft_trend preset must exist',
);
assert(
  presetsSource.includes("cardTypes: ['ncaam-ft-trend', 'ncaam-ft-spread']"),
  'ncaam_ft_trend preset must target ncaam-ft-trend and ncaam-ft-spread card types',
);
{
  const ftIdx = presetsSource.indexOf("id: 'ncaam_ft_trend'");
  const ftBlock = presetsSource.slice(ftIdx, ftIdx + 400);

  assert(
    ftBlock.includes("sports: ['NCAAM']"),
    'ncaam_ft_trend must scope to NCAAM',
  );
  assert(
    ftBlock.includes("markets: ['SPREAD']"),
    'ncaam_ft_trend must scope to SPREAD market',
  );
}

// ─── Welcome Home Fade still present ─────────────────────────────────────
assert(
  presetsSource.includes("id: 'welcome_home'"),
  'welcome_home preset must still exist',
);

// ─── Full Slate still has PASS ────────────────────────────────────────────
{
  const fsIdx = presetsSource.indexOf("id: 'full_slate'");
  const fsBlock = presetsSource.slice(fsIdx, fsIdx + 300);
  assert(
    fsBlock.includes('statuses: FIRE_WATCH_PASS'),
    'full_slate preset must include PASS',
  );
}

console.log('✅ All filter preset + sort + FT-trend contract checks passed');
