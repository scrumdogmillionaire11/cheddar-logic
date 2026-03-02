/*
 * Verifies UI contract for evidence visibility when no official play exists.
 * Run: npm --prefix web run test:ui:evidence
 */

import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';

const filePath = path.resolve('src/components/cards-page-client.tsx');
const source = fs.readFileSync(filePath, 'utf8');

console.log('🧪 UI evidence/no-play contract source tests');

assert(
  source.includes('Evidence ({card.evidence?.length})'),
  'cards page should render explicit Evidence section when evidence exists'
);

assert(
  source.includes("displayPlay.pick === 'NO PLAY'") &&
    source.includes('No official play for this game; evidence signals are shown for context.'),
  'UI should show explicit no-official-play message while still surfacing evidence'
);

console.log('✅ UI evidence/no-play contract source tests passed');
