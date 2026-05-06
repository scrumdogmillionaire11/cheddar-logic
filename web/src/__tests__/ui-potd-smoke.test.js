/*
 * UI POTD smoke test
 * Ensures /play-of-the-day renders and the source keeps the intended empty,
 * posted, and settled-history states.
 *
 * Live mode: CARDS_API_BASE_URL=http://127.0.0.1:3000 node web/src/__tests__/ui-potd-smoke.test.js
 */

const DEFAULT_BASE_URL = 'http://localhost:3000';
const LIVE_COMMAND =
  'CARDS_API_BASE_URL=http://127.0.0.1:3000 node web/src/__tests__/ui-potd-smoke.test.js';

function isConnectionIssue(error) {
  const message = String(error?.message || error || '');
  return (
    message.includes('fetch failed') ||
    message.includes('ECONNREFUSED') ||
    message.includes('ENOTFOUND')
  );
}

function buildFallbackMessage(baseUrl) {
  return (
    `POTD page unavailable at ${baseUrl}; running source fallback checks. ` +
    `To run live assertions: ${LIVE_COMMAND}`
  );
}

async function validatePotdSourceContract(assert) {
  const fs = await import('node:fs/promises');
  const pageSource = await fs.readFile(
    new URL('../app/play-of-the-day/page.tsx', import.meta.url),
    'utf8',
  );
  const clientSource = await fs.readFile(
    new URL('../components/play-of-the-day-client.tsx', import.meta.url),
    'utf8',
  );
  const homeSource = await fs.readFile(
    new URL('../app/page.tsx', import.meta.url),
    'utf8',
  );

  assert.ok(
    pageSource.includes('getPotdResponseData') &&
      pageSource.includes('closeDatabaseReadOnly'),
    'play-of-the-day page must load server data and keep read-only teardown',
  );
  [
    'No play posted yet',
    'No official POTD today',
    'Play of the Day',
    'Bankroll',
    'Recent History',
    'No settled-history rows yet',
    'Today&apos;s Card',
    'Monitored Candidates',
    'Diagnostics',
    'No positive edge',
    'WIN',
    'LOSS',
    'PUSH',
    'Reasoning',
  ].forEach((token) => {
    assert.ok(
      clientSource.includes(token),
      `play-of-the-day client must include ${token}`,
    );
  });
  assert.ok(
    clientSource.includes('StickyBackButton') &&
      clientSource.includes('href="/cards"') &&
      clientSource.includes('href="/results"'),
    'play-of-the-day client must provide existing app navigation',
  );
  assert.ok(
    homeSource.includes('href="/play-of-the-day"') &&
      homeSource.includes('getPotdResponseData') &&
      homeSource.includes('border-emerald-400/60'),
    'homepage must expose a visible POTD link and accent it when a pick is live',
  );
}

async function validateLivePage(baseUrl, assert) {
  const response = await fetch(`${baseUrl}/play-of-the-day`, {
    headers: { Accept: 'text/html' },
  });
  assert.strictEqual(
    response.ok,
    true,
    `POTD page response not ok: ${response.status}`,
  );
  const html = await response.text();
  assert.ok(
    html.includes('Play of the Day'),
    'POTD page HTML must include the page title',
  );
  const match = html.match(/\/_next\/static\/[^"'\s>]+\.js/);
  assert.ok(match, 'POTD page did not reference a Next.js static JS asset');
  const assetResponse = await fetch(`${baseUrl}${match[0]}`, {
    headers: { Accept: 'application/javascript,text/javascript,*/*' },
  });
  assert.strictEqual(
    assetResponse.ok,
    true,
    `Referenced POTD chunk not reachable (${assetResponse.status}): ${match[0]}`,
  );
}

async function run() {
  const assertModule = await import('node:assert');
  const assert = assertModule.default || assertModule;

  const baseUrl = process.env.CARDS_API_BASE_URL || DEFAULT_BASE_URL;
  try {
    await validateLivePage(baseUrl, assert);
  } catch (error) {
    if (!isConnectionIssue(error)) throw error;
    console.warn(`⚠️ ${buildFallbackMessage(baseUrl)}`);
    await validatePotdSourceContract(assert);
  }

  console.log('✅ UI POTD smoke test passed');
}

run().catch((error) => {
  console.error('❌ UI POTD smoke test failed');
  console.error(error.message || error);
  process.exit(1);
});
