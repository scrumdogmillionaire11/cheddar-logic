/*
 * Global stale-asset guard source contract tests.
 * Run: node src/__tests__/global-stale-asset-guard-contract.test.js
 */

import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const filePath = path.resolve(
  __dirname,
  '../components/global-stale-asset-guard.tsx',
);
const source = fs.readFileSync(filePath, 'utf8');

console.log('🧪 Global stale-asset guard source contract tests');

assert(
  source.includes("window.addEventListener('error', onError, true)") &&
    source.includes(
      "window.addEventListener('unhandledrejection', onUnhandledRejection)",
    ),
  'global guard should subscribe to global error + unhandledrejection handlers',
);

assert(
  source.includes('isStaleNextStaticAssetFailure(message)') &&
    source.includes('buildStaleAssetErrorMessage(errorEvent)'),
  'global guard should use shared Next static failure detection utilities',
);

assert(
  source.includes('STALE_ASSET_RELOAD_GUARD_KEY') &&
    source.includes(
      'window.sessionStorage.getItem(STALE_ASSET_RELOAD_GUARD_KEY)',
    ) &&
    source.includes(
      "window.sessionStorage.setItem(STALE_ASSET_RELOAD_GUARD_KEY, '1')",
    ) &&
    source.includes('window.location.reload()'),
  'global guard should reload once per session for stale static assets',
);

assert(
  source.includes("pathname?.startsWith('/cards')"),
  'global guard should defer repeated stale-asset messaging on /cards to local cards UI',
);

console.log('✅ Global stale-asset guard source contract tests passed');
