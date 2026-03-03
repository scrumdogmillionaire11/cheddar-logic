#!/usr/bin/env node

/**
 * Review Discovered Team Variants
 * 
 * This utility helps manually review unknown team name variants that were
 * encountered during normalization.
 * 
 * Run this periodically to:
 * 1. See all unknown team names and how often they appear
 * 2. Decide if they should be added to TEAM_VARIANTS
 * 3. Update normalize.js with new mappings
 * 
 * Usage:
 *   npm run review-discovered-variants
 *   node src/review-discovered-variants.js
 */

const { getDiscoveredTeamVariants, clearDiscoveredTeamVariants } = require('./normalize');

function formatDate(isoString) {
  try {
    const date = new Date(isoString);
    return date.toLocaleString('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  } catch {
    return isoString;
  }
}

function main() {
  const discovered = getDiscoveredTeamVariants();

  if (discovered.length === 0) {
    console.log('✅ No unknown team variants discovered. All team names are recognized.');
    return;
  }

  console.log('\n' + '='.repeat(80));
  console.log('DISCOVERED TEAM NAME VARIANTS');
  console.log('='.repeat(80) + '\n');

  console.log(
    `Found ${discovered.length} unique unknown variant(s) ` +
    `(${discovered.reduce((sum, d) => sum + d.count, 0)} total occurrences)\n`
  );

  console.log('📋 VARIANTS BY FREQUENCY:\n');

  discovered.forEach((item, index) => {
    const pct =
      discovered.length > 1
        ? ((item.count / discovered.reduce((sum, d) => sum + d.count, 0)) * 100).toFixed(1)
        : '100';

    console.log(`${index + 1}. "${item.variant}"`);
    console.log(`   Count: ${item.count} occurrences (${pct}%)`);
    console.log(`   First Seen: ${formatDate(item.firstSeen)}`);
    console.log(`   Last Seen:  ${formatDate(item.lastSeen)}`);
    console.log('');
  });

  console.log('='.repeat(80) + '\n');
  console.log('📝 NEXT STEPS:\n');
  console.log('1. Review the variants above');
  console.log('2. For each recurring variant (appears multiple times):');
  console.log('   - Identify which canonical team it represents');
  console.log('   - Add it to TEAM_VARIANTS in packages/data/src/normalize.js');
  console.log('   - Format: "CANONICAL NAME": ["variant1", "variant2", ...]');
  console.log('3. Run this script again to clear discovered variants: use --clear flag\n');

  // Check if --clear flag is passed
  if (process.argv.includes('--clear')) {
    clearDiscoveredTeamVariants();
    console.log('✅ Clearing discovered variants for next iteration...\n');
  }

  console.log('Example TEAM_VARIANTS entry:');
  console.log(
    `  'NEW YORK KNICKS': ['new york knicks', 'ny knicks', 'knicks', 'nyk'],\n`
  );

  console.log('='.repeat(80) + '\n');
}

main();
