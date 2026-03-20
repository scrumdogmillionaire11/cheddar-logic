'use strict';

require('dotenv').config();
const { v4: uuidV4 } = require('uuid');

const {
  insertJobRun,
  markJobRunSuccess,
  markJobRunFailure,
  shouldRunJobKey,
  withDb,
  getDatabase,
} = require('@cheddar-logic/data');

const JOB_NAME = 'post_discord_cards';
const DEFAULT_CHAR_LIMIT = 1800;
const DISCORD_HARD_LIMIT = 2000;
const DEFAULT_MAX_ROWS = 120;

function parsePayload(value) {
  if (!value) return null;
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function normalizeToken(value) {
  return String(value || '').trim().toUpperCase();
}

function isNonPassCard(card) {
  const payload = card?.payloadData || null;
  const statusCandidates = [
    payload?.action,
    payload?.status,
    payload?.classification,
    payload?.prediction,
    payload?.play_status,
    payload?.display_action,
  ]
    .map(normalizeToken)
    .filter(Boolean);

  if (statusCandidates.some((token) => token.includes('PASS'))) return false;

  const passReasonCandidates = [
    payload?.pass_reason,
    payload?.pass_reason_code,
    ...(Array.isArray(payload?.reason_codes) ? payload.reason_codes : []),
  ]
    .map(normalizeToken)
    .filter(Boolean);

  if (passReasonCandidates.some((token) => token.startsWith('PASS'))) return false;
  if (normalizeToken(payload?.kind) === 'EVIDENCE') return false;

  return true;
}

function isPlayerPropCard(card) {
  const cardType = String(card?.cardType || '').toLowerCase();
  const marketType = String(card?.payloadData?.market_type || '').toLowerCase();
  return (
    cardType.includes('player') ||
    cardType.includes('prop') ||
    marketType === 'prop'
  );
}

function isFirstPeriodCard(card) {
  const cardType = String(card?.cardType || '').toLowerCase();
  const period = String(card?.payloadData?.period || '').toLowerCase();
  const marketKey = String(card?.payloadData?.market_key || '').toLowerCase();
  return (
    period === '1p' ||
    period === 'p1' ||
    cardType.includes('1p') ||
    cardType.includes('first_period') ||
    marketKey.includes(':1p:')
  );
}

function summarizePick(card) {
  const payload = card?.payloadData || {};
  const selection =
    payload?.selection?.team || payload?.selection?.side || payload?.selection || null;
  const line = payload?.line ?? payload?.total ?? null;
  const price = payload?.price ?? null;
  const projectionOnly = payload?.projection_only === true ? ' [projection-only]' : '';
  const side = selection ? ` | ${selection}` : '';
  const lineText = line !== null && line !== undefined ? ` ${line}` : '';
  const priceText = Number.isFinite(Number(price)) ? ` @ ${price}` : '';

  return `${card.matchup} — ${card.cardType}${side}${lineText}${priceText}${projectionOnly}`;
}

function chunkDiscordContent(content, charLimit = DEFAULT_CHAR_LIMIT) {
  const safeLimit = Math.max(400, Math.min(DISCORD_HARD_LIMIT, Number(charLimit) || DEFAULT_CHAR_LIMIT));
  if (content.length <= safeLimit) return [content];

  const lines = content.split('\n');
  const chunks = [];
  let current = '';

  for (const line of lines) {
    const next = current ? `${current}\n${line}` : line;
    if (next.length <= safeLimit) {
      current = next;
      continue;
    }

    if (current) chunks.push(current);

    if (line.length <= safeLimit) {
      current = line;
      continue;
    }

    let remaining = line;
    while (remaining.length > safeLimit) {
      chunks.push(remaining.slice(0, safeLimit));
      remaining = remaining.slice(safeLimit);
    }
    current = remaining;
  }

  if (current) chunks.push(current);
  return chunks;
}

async function sendDiscordMessages({ webhookUrl, messages, fetchImpl = fetch }) {
  const sent = [];
  for (let index = 0; index < messages.length; index += 1) {
    const total = messages.length;
    const prefix = total > 1 ? `[${index + 1}/${total}] ` : '';
    const response = await fetchImpl(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: `${prefix}${messages[index]}` }),
    });
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(`Discord webhook failed (${response.status}): ${body}`);
    }
    sent.push(index + 1);
  }
  return sent.length;
}

function fetchCardsForSnapshot({ maxRows = DEFAULT_MAX_ROWS } = {}) {
  const db = getDatabase();
  const rows = db
    .prepare(
      `
      WITH ranked AS (
        SELECT
          cp.id,
          cp.game_id,
          cp.sport,
          cp.card_type,
          cp.card_title,
          cp.payload_data,
          cp.created_at,
          g.game_time_utc,
          g.away_team,
          g.home_team,
          ROW_NUMBER() OVER (
            PARTITION BY cp.game_id, cp.card_type
            ORDER BY cp.created_at DESC, cp.id DESC
          ) AS rn
        FROM card_payloads cp
        LEFT JOIN games g ON g.game_id = cp.game_id
        WHERE LOWER(cp.sport) != 'fpl'
          AND NOT EXISTS (
            SELECT 1 FROM card_results cr
            WHERE cr.game_id = cp.game_id AND cr.status = 'settled'
          )
      )
      SELECT * FROM ranked
      WHERE rn = 1
      ORDER BY COALESCE(game_time_utc, created_at) ASC, created_at DESC
      LIMIT ?
    `,
    )
    .all(Math.max(1, Number(maxRows) || DEFAULT_MAX_ROWS));

  return rows.map((row) => {
    const matchup =
      row.away_team && row.home_team
        ? `${row.away_team} @ ${row.home_team}`
        : row.card_title || row.game_id;
    return {
      id: row.id,
      gameId: row.game_id,
      sport: row.sport,
      cardType: row.card_type,
      cardTitle: row.card_title,
      createdAt: row.created_at,
      gameTimeUtc: row.game_time_utc,
      payloadData: parsePayload(row.payload_data),
      matchup,
    };
  });
}

function buildDiscordSnapshot({ now = new Date(), cards = [] } = {}) {
  const filtered = cards.filter(isNonPassCard);
  const firstPeriodCards = filtered.filter(isFirstPeriodCard);
  const playerPropCards = filtered.filter(isPlayerPropCard);
  const firstPeriodIds = new Set(firstPeriodCards.map((card) => card.id));
  const playerPropIds = new Set(playerPropCards.map((card) => card.id));

  const coreCards = filtered.filter(
    (card) => !firstPeriodIds.has(card.id) && !playerPropIds.has(card.id),
  );

  function sectionLines(title, sectionCards) {
    const lines = [`${title} (${sectionCards.length})`];
    if (sectionCards.length === 0) {
      lines.push('- none');
      return lines;
    }
    sectionCards.forEach((card) => lines.push(`- ${summarizePick(card)}`));
    return lines;
  }

  const timestamp = now.toISOString();
  const lines = [
    `Cheddar cards snapshot (${timestamp})`,
    `Total non-PASS cards: ${filtered.length}`,
    '',
    ...sectionLines('Core Cards', coreCards),
    '',
    ...sectionLines('Player Props', playerPropCards),
    '',
    ...sectionLines('1P Cards', firstPeriodCards),
  ];

  return {
    content: lines.join('\n'),
    totalCards: filtered.length,
    sectionCounts: {
      core: coreCards.length,
      playerProps: playerPropCards.length,
      firstPeriod: firstPeriodCards.length,
    },
  };
}

async function postDiscordCards({ jobKey = null, dryRun = false } = {}) {
  const enabled = process.env.ENABLE_DISCORD_CARD_WEBHOOKS === 'true';
  const webhookUrl = String(process.env.DISCORD_CARD_WEBHOOK_URL || '').trim();
  const charLimit = Number(process.env.DISCORD_CARD_WEBHOOK_CHAR_LIMIT || DEFAULT_CHAR_LIMIT);
  const maxRows = Number(process.env.DISCORD_CARD_WEBHOOK_MAX_ROWS || DEFAULT_MAX_ROWS);

  if (!enabled) {
    return {
      success: true,
      skipped: true,
      reason: 'disabled',
      message: 'ENABLE_DISCORD_CARD_WEBHOOKS != true',
    };
  }

  if (!webhookUrl) {
    return {
      success: true,
      skipped: true,
      reason: 'missing_webhook_url',
      message: 'DISCORD_CARD_WEBHOOK_URL is unset',
    };
  }

  const runId = `job-${JOB_NAME}-${new Date().toISOString().split('.')[0]}-${uuidV4().slice(0, 8)}`;

  return withDb(async () => {
    if (jobKey && !shouldRunJobKey(jobKey)) {
      return { success: true, skipped: true, reason: 'idempotent_skip', jobKey };
    }

    const cards = fetchCardsForSnapshot({ maxRows });
    const snapshot = buildDiscordSnapshot({ cards, now: new Date() });
    const chunks = chunkDiscordContent(snapshot.content, charLimit);

    if (dryRun) {
      return {
        success: true,
        dryRun: true,
        chunks: chunks.length,
        totalCards: snapshot.totalCards,
        sectionCounts: snapshot.sectionCounts,
      };
    }

    insertJobRun(JOB_NAME, runId, jobKey);
    try {
      const sentCount = await sendDiscordMessages({ webhookUrl, messages: chunks });
      markJobRunSuccess(runId, {
        chunks: sentCount,
        total_cards: snapshot.totalCards,
        sections: snapshot.sectionCounts,
      });
      return {
        success: true,
        jobRunId: runId,
        chunks: sentCount,
        totalCards: snapshot.totalCards,
        sectionCounts: snapshot.sectionCounts,
      };
    } catch (error) {
      markJobRunFailure(runId, error.message);
      return {
        success: false,
        jobRunId: runId,
        error: error.message,
      };
    }
  });
}

if (require.main === module) {
  const dryRun = process.argv.includes('--dry-run');
  postDiscordCards({ dryRun })
    .then((result) => {
      if (result?.success === false) process.exit(1);
      process.exit(0);
    })
    .catch((error) => {
      console.error(`[${JOB_NAME}] Fatal:`, error.message);
      process.exit(1);
    });
}

module.exports = {
  postDiscordCards,
  isNonPassCard,
  isPlayerPropCard,
  isFirstPeriodCard,
  buildDiscordSnapshot,
  chunkDiscordContent,
  sendDiscordMessages,
};
