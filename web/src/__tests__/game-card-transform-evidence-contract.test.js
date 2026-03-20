/*
 * Verifies PLAY/EVIDENCE separation and evidence bubbling in transform.ts.
 * Run: npm --prefix web run test:transform:evidence
 */

import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';

const filePath = path.resolve('src/lib/game-card/transform.ts');
const source = fs.readFileSync(filePath, 'utf8');

console.log('🧪 Transform evidence contract source tests');

assert(
  source.includes('function isPlayItem(play: ApiPlay, sport?: string): boolean') &&
    source.includes("return kind === 'PLAY'"),
  'transform should explicitly identify PLAY items',
);

assert(
  source.includes('function isEvidenceItem(play: ApiPlay, sport?: string): boolean') &&
    source.includes("(play.kind ?? 'PLAY') === 'EVIDENCE'"),
  'transform should explicitly identify EVIDENCE items',
);

assert(
  source.includes('isPlayItem(play, game.sport)') &&
    source.includes('isEvidenceItem(play, game.sport)'),
  'transform should separate play candidates from evidence using sport-aware helpers',
);

assert(
  source.includes('const rawDrivers = game.plays') &&
    source.includes('.filter((play) => isPlayItem(play, game.sport))') &&
    source.includes('.map(playToDriver)'),
  'transform should only convert PLAY items into drivers',
);

assert(
  source.includes('evidence_for_play_id') &&
    source.includes('aggregation_key') &&
    source.includes('evidence_count: linkedEvidence.length'),
  'transform should bubble linked evidence into deterministic evidence_count',
);

assert(
  source.includes('NHL_1P_OVER_LEAN') &&
    source.includes('NHL_1P_UNDER_LEAN') &&
    source.includes('NHL_ML_LEAN') &&
    source.includes('NHL_1P_OVER_PLAY') &&
    source.includes('NHL_1P_UNDER_PLAY') &&
    source.includes('NHL_ML_PLAY'),
  'transform should classify NHL LEAN/PLAY model no-actionable signals as explicit no-edge reason codes',
);

console.log('✅ Transform evidence contract source tests passed');
