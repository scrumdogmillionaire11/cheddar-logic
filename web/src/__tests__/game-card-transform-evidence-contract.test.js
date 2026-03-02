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
  source.includes('function isPlayItem(play: ApiPlay): boolean') && source.includes("(play.kind ?? 'PLAY') === 'PLAY'"),
  'transform should explicitly identify PLAY items'
);

assert(
  source.includes('function isEvidenceItem(play: ApiPlay): boolean') && source.includes("(play.kind ?? 'PLAY') === 'EVIDENCE'"),
  'transform should explicitly identify EVIDENCE items'
);

assert(
  source.includes('const playCandidates = game.plays.filter(isPlayItem);') && source.includes('const evidenceCandidates = game.plays.filter(isEvidenceItem);'),
  'transform should separate play candidates from evidence'
);

assert(
  source.includes('const rawDrivers = game.plays.filter(isPlayItem).map(playToDriver);'),
  'transform should only convert PLAY items into drivers'
);

assert(
  source.includes('evidence_for_play_id') && source.includes('aggregation_key') && source.includes('evidence_count: linkedEvidence.length'),
  'transform should bubble linked evidence into deterministic evidence_count'
);

console.log('✅ Transform evidence contract source tests passed');
