/*
 * Cards chunk recovery source contract tests.
 * Run: node src/__tests__/cards-chunk-recovery-contract.test.js
 */

import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const contextPath = path.resolve(__dirname, '../components/cards/CardsPageContext.tsx');
const sharedPath = path.resolve(__dirname, '../components/cards/shared.ts');
const source =
  fs.readFileSync(contextPath, 'utf8') + '\n' + fs.readFileSync(sharedPath, 'utf8');

console.log('🧪 Cards chunk recovery source contract tests');

assert(
  source.includes("window.addEventListener('error', onError, true)") &&
    source.includes(
      "window.addEventListener('unhandledrejection', onUnhandledRejection)",
    ),
  'cards page should subscribe to global error + unhandledrejection handlers',
);

assert(
  source.includes('STALE_ASSET_RELOAD_GUARD_KEY') &&
    source.includes(
      'window.sessionStorage.getItem(STALE_ASSET_RELOAD_GUARD_KEY)',
    ) &&
    source.includes(
      "window.sessionStorage.setItem(STALE_ASSET_RELOAD_GUARD_KEY, '1')",
    ),
  'cards page should guard reload to one attempt per session',
);

assert(
  source.includes('window.location.reload()') &&
    source.includes('formatStaleAssetUserMessage(message)'),
  'cards page should reload once and then show stable hard-refresh guidance',
);

assert(
  source.includes('CARDS_CHUNK_LOAD_FAILED') &&
    source.includes('CARDS_FETCH_FAILED'),
  'cards page should emit explicit chunk and fetch log codes',
);

assert(
  source.includes('isStaleNextStaticAssetFailure(message)') &&
    source.includes('extractNextStaticAssetPath(message)'),
  'cards stale-asset detector should use shared Next static failure utilities',
);

assert(
  source.includes('buildStaleAssetErrorMessage(errorEvent)'),
  'cards global error handler should use shared static-asset error message extraction',
);

assert(
  source.includes('createTimeoutSignal(CLIENT_FETCH_TIMEOUT_MS)') &&
    !source.includes('AbortSignal.timeout(CLIENT_FETCH_TIMEOUT_MS)'),
  'cards fetch path should use timeout compatibility helper (no direct AbortSignal.timeout call)',
);

console.log('✅ Cards chunk recovery source contract tests passed');
