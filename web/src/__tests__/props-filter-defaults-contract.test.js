/*
 * Behavioral contract: props-mode defaults keep PASS-backed rows visible.
 */

import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '../../..');
const webRoot = path.resolve(repoRoot, 'web');

console.log('Behavior props filter defaults contract tests');

execFileSync(process.execPath, ['--import', 'tsx/esm', 'src/__tests__/game-card-filters.test.js'], {
  cwd: webRoot,
  stdio: 'inherit',
});

execFileSync(process.execPath, ['--import', 'tsx/esm', 'src/__tests__/filters-pass-play-main-view-regression.test.js'], {
  cwd: webRoot,
  stdio: 'inherit',
});

execFileSync(process.execPath, ['--import', 'tsx/esm', 'src/__tests__/game-card-transform-hardening.test.js'], {
  cwd: webRoot,
  stdio: 'inherit',
});

console.log('Behavior props filter defaults contract tests passed');
