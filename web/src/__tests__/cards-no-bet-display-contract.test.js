/*
 * Verifies cards UI display contract for no-bet plays:
 * 1) no canonical bet cannot render LEAN/PLAY unless held for verification/proxy guardrails
 * 2) NO PLAY text does not append live odds
 *
 * Run: node web/src/__tests__/cards-no-bet-display-contract.test.js
 */

import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';

const cardsPagePath = path.resolve('web/src/components/cards-page-client.tsx');
const source = fs.readFileSync(cardsPagePath, 'utf8');

console.log('cards no-bet display contract tests');

assert(
  source.includes('const hasCanonicalBet = Boolean(displayPlay.bet);') &&
    source.includes('const shouldPreserveNoBetLean = isEdgeVerification || isProxyCapped;') &&
    source.includes('!hasCanonicalBet') &&
    source.includes("inferredDecision !== 'PASS'"),
  'cards UI should downgrade no-bet LEAN/PLAY display to PASS unless explicit hold guardrails apply',
);

assert(
  source.includes(": displayPlay.pick === 'NO PLAY'") &&
    source.includes("? 'NO PLAY'"),
  'cards UI should render plain NO PLAY without appending live odds',
);

console.log('cards no-bet display contract tests passed');
