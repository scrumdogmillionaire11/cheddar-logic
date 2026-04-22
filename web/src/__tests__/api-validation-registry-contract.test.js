import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  getValidationRegistryPaths,
  isValidationPathRegistered,
} from '../lib/api-security/validation.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const API_ROOT = path.resolve(__dirname, '../app/api');

function walkRoutes(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...walkRoutes(fullPath));
      continue;
    }
    if (entry.isFile() && entry.name === 'route.ts') {
      files.push(fullPath);
    }
  }

  return files;
}

function collectSecuredRoutePaths() {
  const routeFiles = walkRoutes(API_ROOT);
  const paths = new Set();

  for (const routeFile of routeFiles) {
    const content = fs.readFileSync(routeFile, 'utf8');
    const regex = /performSecurityChecks\s*\(\s*request\s*,\s*['"]([^'"]+)['"]\s*\)/g;
    let match = regex.exec(content);
    while (match) {
      paths.add(match[1]);
      match = regex.exec(content);
    }
  }

  return Array.from(paths).sort();
}

async function runTests() {
  let passed = 0;
  let failed = 0;

  function test(name, fn) {
    try {
      fn();
      console.log(`  PASS ${name}`);
      passed += 1;
    } catch (error) {
      console.error(`  FAIL ${name}`);
      console.error(error);
      failed += 1;
    }
  }

  console.log('Running API validation registry contract tests');

  test('all routes using performSecurityChecks are registered in validation.ts', () => {
    const securedPaths = collectSecuredRoutePaths();
    const missing = securedPaths.filter((routePath) => !isValidationPathRegistered(routePath));

    assert.equal(
      missing.length,
      0,
      `Missing validation registrations for secured routes: ${missing.join(', ')}`,
    );
  });

  test('validation registry includes /api/performance and /api/model-outputs', () => {
    const registry = new Set(getValidationRegistryPaths());
    assert.equal(registry.has('/api/performance'), true);
    assert.equal(registry.has('/api/model-outputs'), true);
  });

  console.log(`\nResults: ${passed} passed, ${failed} failed`);
  if (failed > 0) {
    process.exit(1);
  }
  process.exit(0);
}

runTests().catch((error) => {
  console.error(error);
  process.exit(1);
});
