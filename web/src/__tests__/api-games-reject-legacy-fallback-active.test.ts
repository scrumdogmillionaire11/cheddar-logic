import assert from 'node:assert';

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
} finally {
  process.env.ENFORCE_CANONICAL_DECISION_ONLY = prevEnforce;
}

console.log('API games canonical-only runtime behavior tests passed');
