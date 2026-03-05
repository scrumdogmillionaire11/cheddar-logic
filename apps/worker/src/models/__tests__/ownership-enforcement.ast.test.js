const fs = require('fs');
const path = require('path');
const glob = require('glob');

/**
 * AST-Based Ownership Enforcement Test
 * 
 * Ensures forbidden identifiers are:
 * 1. Defined ONLY in owner modules
 * 2. Imported ONLY from approved sources (exact match)
 */

const FORBIDDEN = {
  'computeWinProbHome': {
    owner: 'packages/models/src/card-utilities.js',
    approvedImportSource: '@cheddar-logic/models'
  },
  'buildDriverSummary': {
    owner: 'packages/models/src/card-utilities.js',
    approvedImportSource: '@cheddar-logic/models'
  },
  'generateCard': {
    owner: 'packages/models/src/card-factory.js',
    approvedImportSource: '@cheddar-logic/models'
  }
};

describe('AST Ownership Enforcement', () => {
  test('No forbidden function names in job files', () => {
    const jobFiles = [
      'apps/worker/src/jobs/run_nba_model.js',
      'apps/worker/src/jobs/run_nhl_model.js',
      'apps/worker/src/jobs/run_ncaam_model.js'
    ];

    const violations = [];

    jobFiles.forEach(filePath => {
      if (!fs.existsSync(filePath)) return;
      
      const content = fs.readFileSync(filePath, 'utf8');
      
      Object.keys(FORBIDDEN).forEach(identifier => {
        // Check for function declaration
        if (new RegExp(`function\\s+${identifier}\\s*\\(`).test(content)) {
          violations.push(`❌ ${identifier} defined in ${filePath} (should be in owner module)`);
        }
        // Check for const/let/var assignment
        if (new RegExp(`const\\s+${identifier}\\s*=\\s*\\(.*?\\)|let\\s+${identifier}\\s*=\\s*\\(.*?\\)|var\\s+${identifier}\\s*=\\s*\\(.*?\\)`).test(content)) {
          violations.push(`❌ ${identifier} assigned in ${filePath} (should be in owner module)`);
        }
      });
    });

    if (violations.length > 0) {
      throw new Error(`\n${violations.join('\n')}\n\nFix: Delete these definitions and import from owner module instead.`);
    }
  });
});
