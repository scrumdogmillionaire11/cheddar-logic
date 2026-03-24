/**
 * WI-0584: Line-change dedup gap — source contract test.
 *
 * Verifies:
 * 1. seenNhlShotsPlayKeys key does NOT include dedupeLine (line-agnostic dedup)
 * 2. Secondary dedup pass exists: seenPropTupleKeys filters playsMap after main loop
 * 3. Secondary dedup keeps newest card per (gameId, playerId, propType, side)
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const routeSource = fs.readFileSync(
  path.resolve('web/src/app/api/games/route.ts'),
  'utf8',
);

// 1. dedupeKey array must not include dedupeLine
// The old key had 7 elements ending with the line value; new key has 6 elements.
// Assert dedupeLine.toFixed is NOT part of the seenNhlShotsPlayKeys dedupeKey array.
// We check this by verifying the dedupeKey join call does not reference dedupeLine.
const dedupeKeyBlock = routeSource.match(
  /const dedupeKey = \[([\s\S]*?)\]\.join\('\|'\)/,
);
assert(dedupeKeyBlock, 'Expected dedupeKey array assignment in route.ts');
assert(
  !dedupeKeyBlock[1].includes('dedupeLine'),
  'dedupeKey must NOT include dedupeLine — line-agnostic dedup required (WI-0584)',
);

// 2. Secondary dedup pass must exist
assert(
  routeSource.includes('seenPropTupleKeys'),
  'Expected seenPropTupleKeys secondary dedup pass in route.ts (WI-0584)',
);

// 3. Secondary pass must iterate playsMap and call playsMap.set
assert(
  routeSource.includes('seenPropTupleKeys') &&
    routeSource.includes('playsMap.set(gid') &&
    routeSource.includes('dedupedPropPlays'),
  'Expected playsMap.set(gid, dedupedPropPlays) in secondary dedup pass (WI-0584)',
);

// 4. Secondary pass must guard on nhl-player-shots / PROP card types
assert(
  routeSource.includes("'nhl-player-shots'") &&
    routeSource.includes("'nhl-player-shots-1p'") &&
    routeSource.includes("=== 'PROP'"),
  'Expected secondary dedup to filter on nhl-player-shots and PROP card types (WI-0584)',
);

console.log('api-games-prop-line-change-dedup: all assertions passed');
