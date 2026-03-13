/*
 * WI-0420: Active tab actionable-call regression test
 * Run: node web/src/__tests__/active-tab-actionable-filter.test.js
 */

import assert from 'node:assert';
import fs from 'node:fs';

const cardsSource = fs.readFileSync(
  new URL('../components/cards-page-client.tsx', import.meta.url),
  'utf8',
);
const filtersSource = fs.readFileSync(
  new URL('../lib/game-card/filters.ts', import.meta.url),
  'utf8',
);

console.log('🧪 WI-0420 active-tab actionable filter source tests');

assert(
  cardsSource.includes('const statusesWithoutPass = filters.statuses.filter(') &&
    cardsSource.includes("(status) => status !== 'PASS'"),
  'active lifecycle filters should strip PASS from statuses',
);

assert(
  /statusesWithoutPass\.length\s*>\s*0\s*\?\s*statusesWithoutPass\s*:\s*\[\s*'FIRE'\s*,\s*'WATCH'\s*\]/.test(
    cardsSource,
  ),
  'active lifecycle filters should default to FIRE/WATCH if statuses become empty',
);

assert(
  cardsSource.includes('hasClearPlay: true'),
  'active lifecycle filters should force hasClearPlay=true',
);

assert(
  !cardsSource.includes("[...filters.statuses, 'PASS']"),
  'active lifecycle filters should not append PASS',
);

assert(
  filtersSource.includes('function hasActionablePlayCall(card: GameCard): boolean'),
  'filters.ts should define hasActionablePlayCall helper',
);

assert(
  filtersSource.includes(
    'if (play.market === \'NONE\' || play.pick === \'NO PLAY\') return false;',
  ),
  'actionable helper should reject NONE market and NO PLAY picks',
);

assert(
  filtersSource.includes('const officialStatus = play.decision_v2?.official_status;') &&
    filtersSource.includes(
      "return officialStatus === 'PLAY' || officialStatus === 'LEAN';",
    ),
  'actionable helper should use canonical decision_v2 official status when available',
);

assert(
  filtersSource.includes('const displayAction = getPlayDisplayAction(play);') &&
    filtersSource.includes(
      "return displayAction === 'FIRE' || displayAction === 'HOLD';",
    ),
  'actionable helper should fall back to display action FIRE/HOLD',
);

assert(
  /function filterByHasPicks[\s\S]*return hasActionablePlayCall\(card\);/.test(
    filtersSource,
  ),
  'filterByHasPicks should use shared actionable helper',
);

assert(
  /function filterByClearPlay[\s\S]*return hasActionablePlayCall\(card\);/.test(
    filtersSource,
  ),
  'filterByClearPlay should use shared actionable helper',
);

console.log('✅ WI-0420 active-tab actionable filter source tests passed');
