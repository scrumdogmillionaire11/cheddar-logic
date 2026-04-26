import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const routeHandlerPath = path.resolve(__dirname, '../lib/games/route-handler.ts');
const source = fs.readFileSync(routeHandlerPath, 'utf8');

assert(
	source.includes('export function shouldSynthesizeProjectionSurfaceDecisionV2('),
	'expected shouldSynthesizeProjectionSurfaceDecisionV2 export in games route handler',
);
assert(
	source.includes("return lifecycleMode !== 'active';"),
	'expected active-mode synthesis gate to fail closed',
);
assert(
	source.includes('if (!shouldSynthesizeProjectionSurfaceDecisionV2(lifecycleMode))'),
	'expected projection-surface fallback branch to reject active-mode synthesis',
);

console.log('API games reject legacy fallback active source-contract tests passed');
