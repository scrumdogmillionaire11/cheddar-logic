/*
 * Regression guard: PASS plays must not surface in the main view (FIRE/WATCH filter).
 *
 * Covers two leakage vectors that were fixed:
 *   1. Edge-verification blocked PASS cards with non-'NO PLAY' pick text bypassed the
 *      hasActionablePlayCall pick-text check — now caught by explicit action/classification guard.
 *   2. Driver-tag (HAS_FIRE / HAS_WATCH) re-promotion inside filterByActionability allowed
 *      PASS-decision cards with strong drivers to re-enter the FIRE/WATCH path — removed.
 *
 * Run: node --experimental-vm-modules web/src/__tests__/filters-pass-play-main-view-regression.test.js
 *      OR via: npm --prefix web run test:ui:cards (picks up via jest glob)
 */

import assert from 'node:assert';
import fs from 'node:fs';

const filtersSource = fs.readFileSync(
  new URL('../lib/game-card/filters.ts', import.meta.url),
  'utf8',
);

console.log('🧪 PASS-play main-view regression source tests');

// ── Fix 1: hasActionablePlayCall must reject explicit PASS action/classification ──

assert(
  filtersSource.includes("if (play.action === 'PASS' || play.classification === 'PASS') return false;"),
  'hasActionablePlayCall must reject play.action/classification === PASS before inspecting pick text',
);

assert(
  filtersSource.includes("if (play.decision_v2?.official_status === 'PASS') return false;"),
  'hasActionablePlayCall must reject decision_v2.official_status === PASS early',
);

// Ensure the early PASS guard comes BEFORE the pick-text check (line order matters)
const actionGuardIdx = filtersSource.indexOf(
  "if (play.action === 'PASS' || play.classification === 'PASS') return false;",
);
const pickTextCheckIdx = filtersSource.indexOf(
  "if (play.market === 'NONE' || play.pick === 'NO PLAY') return false;",
);
assert(
  actionGuardIdx !== -1 && pickTextCheckIdx !== -1 && actionGuardIdx < pickTextCheckIdx,
  'PASS action guard must appear before pick-text (NO PLAY) check in hasActionablePlayCall',
);

// ── Fix 2: filterByActionability must not re-promote PASS via driver tags ──

assert(
  !filtersSource.includes("card.tags.includes(GAME_TAGS.HAS_FIRE)") ||
    (() => {
      // Verify the HAS_FIRE tag reference (if it exists) is NOT inside the
      // displayAction==='PASS' fallback block of filterByActionability.
      // The block pattern after the fix only has expressionChoice fallback.
      const blockStart = filtersSource.indexOf(
        "// Allow expressionChoice to override a PASS display action, but never driver",
      );
      const blockEnd = filtersSource.indexOf('  }', blockStart);
      const blockContent = blockStart !== -1 ? filtersSource.slice(blockStart, blockEnd) : '';
      return !blockContent.includes('HAS_FIRE') && !blockContent.includes('HAS_WATCH');
    })(),
  'filterByActionability PASS fallback block must not contain HAS_FIRE / HAS_WATCH tag re-promotion',
);

assert(
  filtersSource.includes(
    '// Allow expressionChoice to override a PASS display action, but never driver',
  ),
  'filterByActionability should have the guard comment explaining why driver tags are excluded',
);

// ── Invariant: expressionChoice is still allowed to override PASS ──

assert(
  /Allow expressionChoice to override[\s\S]*?expressionChoice\?\.status/.test(filtersSource),
  'filterByActionability must still allow expressionChoice.status to override PASS',
);

// ── Invariant: hasActionablePlayCall still validates official_status PLAY/LEAN ──

assert(
  filtersSource.includes(
    "return officialStatus === 'PLAY' || officialStatus === 'LEAN';",
  ),
  'hasActionablePlayCall must still validate decision_v2 official_status PLAY/LEAN',
);

// ── Invariant: default game filters remain FIRE/WATCH only ──

const defaultFiltersIdx = filtersSource.indexOf('DEFAULT_GAME_FILTERS');
const defaultBlockEnd = filtersSource.indexOf('};', defaultFiltersIdx);
const defaultBlock = filtersSource.slice(defaultFiltersIdx, defaultBlockEnd);

assert(
  defaultBlock.includes("statuses: ['FIRE', 'WATCH']"),
  'DEFAULT_GAME_FILTERS must keep statuses: [FIRE, WATCH] — no PASS in main view defaults',
);

assert(
  !defaultBlock.includes("'PASS'"),
  'DEFAULT_GAME_FILTERS must not include PASS in statuses',
);

console.log('✓ All PASS-play main-view regression guards passed');
