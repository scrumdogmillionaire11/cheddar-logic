import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const routePath = path.resolve(__dirname, '../app/api/cards/route.ts');
const source = fs.readFileSync(routePath, 'utf8');

assert(
	source.includes('export function shouldApplyGlobalRunFallback(lifecycleMode: LifecycleMode): boolean'),
	'expected shouldApplyGlobalRunFallback export in cards route',
);
assert(
	source.includes("return lifecycleMode !== 'active';"),
	'expected active-mode fallback gate to fail closed',
);
assert(
	source.includes('shouldApplyGlobalRunFallback(lifecycleMode)'),
	'expected legacy fallback query path to consult lifecycle gate helper',
);

console.log('API cards no-global-fallback active source-contract tests passed');
