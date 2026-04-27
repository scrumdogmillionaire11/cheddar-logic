import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';

import { resolveLiveOfficialStatus } from '../lib/games/route-handler';

const prevEnforce = process.env.ENFORCE_CANONICAL_DECISION_ONLY;
process.env.ENFORCE_CANONICAL_DECISION_ONLY = 'true';

try {
  const legacyOnlyPlay = {
    action: 'FIRE',
    classification: 'BASE',
    status: 'FIRE',
  };

  assert.strictEqual(
    resolveLiveOfficialStatus(legacyOnlyPlay as never),
    'PASS',
    'games runtime read path must ignore legacy action/classification/status when canonical decision is missing',
  );

  const canonicalPlay = {
    decision_v2: {
      official_status: 'PLAY',
      canonical_envelope_v2: {
        official_status: 'PLAY',
      },
    },
  };

  assert.strictEqual(
    resolveLiveOfficialStatus(canonicalPlay as never),
    'PLAY',
    'games runtime read path must honor canonical decision_v2',
  );

  const routeHandlerSource = fs.readFileSync(
    path.resolve(process.cwd(), 'src/lib/games/route-handler.ts'),
    'utf8',
  );
  assert.ok(
    routeHandlerSource.includes('typeof payload.core_inputs_complete === \'boolean\''),
    '/api/games route-handler must prioritize namespaced core_inputs_complete before legacy projection_inputs_complete',
  );
  assert.ok(
    routeHandlerSource.includes('payload.core_missing_inputs') &&
      routeHandlerSource.includes('payloadPlay?.core_missing_inputs'),
    '/api/games route-handler must surface namespaced core_missing_inputs on mixed rows',
  );
} finally {
  process.env.ENFORCE_CANONICAL_DECISION_ONLY = prevEnforce;
}

console.log('API games canonical-only runtime behavior tests passed');
