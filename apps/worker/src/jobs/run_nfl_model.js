'use strict';

/**
 * @deprecated Archived by WI-2780.
 *
 * NFL model execution is intentionally disabled until a full data layer
 * reintroduction decision is completed.
 */

const ARCHIVE_PATH = './_archive/run_nfl_model';

function disabledResult(jobKey = null) {
  const reason = 'NFL model job archived; scheduler registration removed (WI-2780).';
  return {
    success: true,
    skipped: true,
    archived: true,
    jobKey,
    reason,
  };
}

async function runNFLModel({ jobKey = null } = {}) {
  const result = disabledResult(jobKey);
  console.warn(`[NFLModel] ${result.reason}`);
  console.warn(`[NFLModel] Archived implementation snapshot: ${ARCHIVE_PATH}`);
  return result;
}

function generateNFLCard() {
  throw new Error('generateNFLCard is archived with run_nfl_model implementation.');
}

if (require.main === module) {
  runNFLModel()
    .then(() => process.exit(0))
    .catch((error) => {
      console.error('Uncaught error:', error);
      process.exit(1);
    });
}

module.exports = { runNFLModel, generateNFLCard };
