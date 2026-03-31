/*
 * FPL weekly report card contract test
 * Source-inspection test — no runtime component imports.
 * Verifies component file and fpl-api.ts against WI-0661 contract requirements.
 * Run: node web/src/__tests__/fpl-weekly-report-card-contract.test.js
 */

async function run() {
  const assertModule = await import('node:assert');
  const assert = assertModule.default || assertModule;
  const fs = await import('node:fs/promises');

  const componentSource = await fs.readFile(
    new URL('../components/fpl-weekly-report-card.tsx', import.meta.url),
    'utf8',
  );

  assert.ok(
    componentSource.includes("from '@/lib/fpl-api'"),
    'fpl-weekly-report-card.tsx must import from @/lib/fpl-api',
  );

  assert.ok(
    componentSource.includes('reportCard: WeeklyReportCard'),
    'fpl-weekly-report-card.tsx must use reportCard: WeeklyReportCard prop type',
  );

  assert.ok(
    componentSource.includes('captain_accuracy'),
    'fpl-weekly-report-card.tsx must surface captain_accuracy',
  );

  assert.ok(
    componentSource.includes('transfer_quality'),
    'fpl-weekly-report-card.tsx must surface transfer_quality',
  );

  assert.ok(
    componentSource.includes('missed_opportunities'),
    'fpl-weekly-report-card.tsx must surface missed_opportunities',
  );

  assert.ok(
    componentSource.includes('profile_adherence'),
    'fpl-weekly-report-card.tsx must surface profile_adherence',
  );

  assert.ok(
    componentSource.includes('drift_flags'),
    'fpl-weekly-report-card.tsx must surface drift_flags',
  );

  assert.ok(
    componentSource.includes('expected_pts'),
    'fpl-weekly-report-card.tsx must surface expected_pts',
  );

  assert.ok(
    componentSource.includes('actual_pts'),
    'fpl-weekly-report-card.tsx must surface actual_pts',
  );

  assert.ok(
    componentSource.includes('Weekly Report Card'),
    'fpl-weekly-report-card.tsx must render "Weekly Report Card" heading',
  );

  assert.ok(
    !componentSource.includes('captainCorrect'),
    'fpl-weekly-report-card.tsx must not contain hardcoded captainCorrect computation logic',
  );

  assert.ok(
    !componentSource.includes('captainWrong'),
    'fpl-weekly-report-card.tsx must not contain hardcoded captainWrong computation logic',
  );

  const apiSource = await fs.readFile(
    new URL('../lib/fpl-api.ts', import.meta.url),
    'utf8',
  );

  assert.ok(
    apiSource.includes('export interface WeeklyReportCard'),
    'fpl-api.ts must export interface WeeklyReportCard',
  );

  assert.ok(
    apiSource.includes('captain_accuracy?: string | null'),
    'fpl-api.ts WeeklyReportCard must include captain_accuracy?: string | null',
  );

  assert.ok(
    apiSource.includes('transfer_quality?: string | null'),
    'fpl-api.ts WeeklyReportCard must include transfer_quality?: string | null',
  );

  assert.ok(
    apiSource.includes('missed_opportunities?: string[] | null'),
    'fpl-api.ts WeeklyReportCard must include missed_opportunities?: string[] | null',
  );

  assert.ok(
    apiSource.includes('profile_adherence?: string | null'),
    'fpl-api.ts WeeklyReportCard must include profile_adherence?: string | null',
  );

  assert.ok(
    apiSource.includes('weekly_report_card?: WeeklyReportCard | null'),
    'fpl-api.ts DetailedAnalysisResponse must include weekly_report_card?: WeeklyReportCard | null',
  );

  console.log('✅ FPL weekly report card contract test passed');
}

run().catch((error) => {
  console.error('❌ FPL weekly report card contract test failed');
  console.error(error.message || error);
  process.exit(1);
});
