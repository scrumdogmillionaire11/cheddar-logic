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
const ET_TIME_FORMATTER = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York',
  hour: 'numeric',
  minute: '2-digit',
  hour12: true,
});

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

function compactToken(value) {
  return String(value || '').trim();
}

function formatEtTime(value) {
  const date = new Date(value || '');
  if (Number.isNaN(date.getTime())) return 'TBD ET';
  return `${ET_TIME_FORMATTER.format(date)} ET`;
}

function sportLabel(sport) {
  const token = normalizeToken(sport);
  if (token === 'NBA') return '🏀 NBA';
  if (token === 'NHL') return '🏒 NHL';
  if (token === 'NFL') return '🏈 NFL';
  if (token === 'SOCCER') return '⚽ Footy';
  return `🎯 ${token || 'SPORT'}`;
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

  return true;
}

function isDisplayableWebhookCard(card) {
  const payload = card?.payloadData || {};

  // Player prop cards (e.g. nhl-player-shots) don't carry kind='PLAY' at the
  // root and store their selection under payload.play.selection — handle them
  // separately before the generic gate logic runs.
  if (isPlayerPropCard(card)) {
    const propAction = normalizeToken(payload?.play?.action || payload?.action || payload?.status);
    const propClassification = normalizeToken(
      payload?.play?.classification || payload?.classification,
    );
    const propSelection = payload?.play?.selection ?? payload?.selection;
    const propHasExplicitPass =
      propAction.includes('PASS') || propClassification.includes('PASS');
    if (propHasExplicitPass) return true; // show in PASS/blocked section
    const propActionable = ['FIRE', 'WATCH', 'LEAN', 'HOLD'].includes(propAction);
    return propActionable && propSelection != null;
  }

  const isOnePeriod = isFirstPeriodCard(card);
  const kind = normalizeToken(payload?.kind);
  const action = normalizeToken(payload?.action || payload?.status);
  const classification = normalizeToken(payload?.classification);
  const onePeriodModelCall = normalizeToken(payload?.one_p_model_call);
  const hasSelection = payload?.selection !== null && payload?.selection !== undefined;
  const actionableByAction = ['FIRE', 'WATCH', 'LEAN', 'HOLD'].includes(action);
  const actionableByClassification = ['BASE', 'LEAN'].includes(classification);

  const reasonTokens = [
    normalizeToken(payload?.pass_reason),
    normalizeToken(payload?.pass_reason_code),
    ...(Array.isArray(payload?.reason_codes) ? payload.reason_codes.map(normalizeToken) : []),
  ].filter(Boolean);
  const hasExplicitPass =
    action.includes('PASS') ||
    classification.includes('PASS') ||
    onePeriodModelCall.includes('PASS') ||
    reasonTokens.some((token) => token.startsWith('PASS') || token.includes('NO_PLAY'));
  const hasBlockedState =
    action.includes('BLOCK') ||
    action.includes('GATE') ||
    classification.includes('BLOCK') ||
    classification.includes('GATE') ||
    reasonTokens.some((token) => token.includes('BLOCK') || token.includes('GATE'));

  if (hasExplicitPass || hasBlockedState) return true;

  if (isOnePeriod) {
    const isActionableOnePeriodStatus = ['FIRE', 'WATCH', 'LEAN', 'HOLD'].includes(action);
    const isActionableOnePeriodCall =
      !onePeriodModelCall.includes('PASS') &&
      (onePeriodModelCall.includes('OVER') || onePeriodModelCall.includes('UNDER'));
    if (isActionableOnePeriodCall || isActionableOnePeriodStatus) {
      return payload?.projection_only !== true;
    }
  }

  if (kind !== 'PLAY') return false;
  if (!actionableByAction && !actionableByClassification) return false;
  if (classification === 'PASS') return false;
  if (onePeriodModelCall.includes('PASS')) return false;
  if (!hasSelection) return false;
  if (payload?.projection_only === true) return false;
  return true;
}

function marketConflictKey(card) {
  const payload = card?.payloadData || {};
  const cardType = String(card?.cardType || '').toLowerCase();
  const marketKey = String(payload?.market_key || '').toLowerCase();
  const marketType = String(payload?.market_type || '').toLowerCase();
  const normalizedType = cardType.replace(/_(home|away)$/i, '');
  const marketToken = marketKey || marketType || normalizedType || 'unknown_market';
  return `${card?.gameId || card?.matchup || 'unknown_game'}::${marketToken}`;
}

function prioritizeClearPlays(cards) {
  const grouped = new Map();
  for (const card of cards) {
    const key = marketConflictKey(card);
    const existing = grouped.get(key);
    if (!existing) {
      grouped.set(key, card);
      continue;
    }

    const existingCreated = Date.parse(existing.createdAt || '') || 0;
    const currentCreated = Date.parse(card.createdAt || '') || 0;

    if (currentCreated >= existingCreated) {
      grouped.set(key, card);
    }
  }
  return Array.from(grouped.values());
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
  const hasPrice = price !== null && price !== undefined && String(price).trim() !== '';
  const priceText = hasPrice && Number.isFinite(Number(price)) ? ` @ ${price}` : '';

  return `${card.matchup} — ${card.cardType}${side}${lineText}${priceText}${projectionOnly}`;
}

function classifyDecisionBucket(card) {
  const payload = card?.payloadData || {};
  const action = normalizeToken(payload?.action || payload?.status);
  const classification = normalizeToken(payload?.classification);
  const reasons = [
    normalizeToken(payload?.pass_reason),
    normalizeToken(payload?.pass_reason_code),
    ...(Array.isArray(payload?.reason_codes) ? payload.reason_codes.map(normalizeToken) : []),
  ].filter(Boolean);

  const hasPass =
    action.includes('PASS') ||
    classification.includes('PASS') ||
    reasons.some((token) => token.startsWith('PASS') || token.includes('NO_PLAY'));
  const hasBlocked =
    action.includes('BLOCK') ||
    action.includes('GATE') ||
    classification.includes('BLOCK') ||
    classification.includes('GATE') ||
    reasons.some((token) => token.includes('BLOCK') || token.includes('GATE'));

  if (hasPass || hasBlocked) return 'pass_blocked';
  if (action === 'FIRE' || classification === 'BASE') return 'official';
  if (['WATCH', 'LEAN', 'HOLD'].includes(action) || classification === 'LEAN') return 'lean';
  return 'lean';
}

function normalizeMarketTag(card) {
  const payload = card?.payloadData || {};
  const cardType = String(card?.cardType || '').toLowerCase();
  const marketType = String(payload?.market_type || '').toLowerCase();
  const marketKey = String(payload?.market_key || '').toLowerCase();
  const token = `${marketType} ${marketKey} ${cardType}`;

  if (token.includes('asian_handicap') || token.includes('spread') || token.includes('handicap')) return 'SPREAD';
  if (token.includes('moneyline') || token.includes(':h2h') || token.includes('ml')) return 'ML';
  if (token.includes('team_total')) return 'TEAM TOTAL';
  if (token.includes('tsoa')) return 'TSOA';
  if (token.includes('anytime')) return 'ANYTIME';
  if (token.includes('sot')) return 'SOT';
  if (token.includes('shots')) return 'SHOTS';
  if (token.includes('1p') || token.includes('first_period')) return '1P';
  if (token.includes('total') || token.includes('over_under') || token.includes(':totals')) return 'TOTAL';

  return normalizeToken(payload?.market_type || card?.cardType || 'MARKET');
}

function selectionSummary(card) {
  const payload = card?.payloadData || {};
  const selection = payload?.selection;
  if (selection && typeof selection === 'object') {
    return compactToken(selection.team || selection.side || selection.player || selection.name || '');
  }
  return compactToken(selection);
}

function lineSummary(card) {
  const payload = card?.payloadData || {};
  const line = payload?.line ?? payload?.total ?? payload?.market_line;
  if (line === null || line === undefined || String(line).trim() === '') return '';
  return String(line).trim();
}

function priceSummary(card) {
  const payload = card?.payloadData || {};
  const price = payload?.price ?? payload?.market_price_over ?? payload?.market_price_under;
  if (price === null || price === undefined || String(price).trim() === '') return '';
  const value = String(price).trim();
  return value.startsWith('+') || value.startsWith('-') ? value : `${value}`;
}

function decisionReason(card) {
  const payload = card?.payloadData || {};
  const direct = payload?.pass_reason_code || payload?.pass_reason;
  if (direct) return normalizeToken(direct);
  const reasonCode = Array.isArray(payload?.reason_codes) ? payload.reason_codes[0] : null;
  if (reasonCode) return normalizeToken(reasonCode);
  if (payload?.blocked_reason_code) return normalizeToken(payload.blocked_reason_code);
  return 'PASS_NO_EDGE';
}

function summarizeReasoning(card) {
  const payload = card?.payloadData || {};
  const why =
    payload?.why ||
    payload?.reason ||
    payload?.notes ||
    payload?.rationale ||
    payload?.analysis_reason ||
    '';
  return compactToken(why);
}

function metricSummary(card) {
  const payload = card?.payloadData || {};
  const model = payload?.model_projection ?? payload?.model_line ?? payload?.projection ?? payload?.expected_total;
  const edge = payload?.edge ?? payload?.edge_pct ?? payload?.edge_over_pp;
  const ev = payload?.expected_value ?? payload?.ev ?? payload?.ev_over;

  const parts = [];
  if (model !== null && model !== undefined && String(model).trim() !== '') parts.push(`Model: ${model}`);
  if (edge !== null && edge !== undefined && String(edge).trim() !== '') parts.push(`Edge: ${edge}`);
  if (ev !== null && ev !== undefined && String(ev).trim() !== '') parts.push(`EV: ${ev}`);
  return parts.join(' | ');
}

function renderDecisionLine(card, bucket) {
  const payload = card?.payloadData || {};

  // Player prop cards carry their full pick string in payload.prediction (same as
  // play.pick_string). Use that directly — the nested play.selection structure
  // doesn't surface through the generic selection/line/price helpers.
  if (isPlayerPropCard(card)) {
    const pickStr = compactToken(payload?.prediction || payload?.play?.pick_string || '');
    if (bucket === 'pass_blocked') {
      return `PROP | ${pickStr || 'No official play'}\nReason: ${decisionReason(card)}`;
    }
    const why = summarizeReasoning(card);
    const lines = [`PROP | ${pickStr || 'No official play'}`];
    if (why) lines.push(`Why: ${why}`);
    return lines.join('\n');
  }

  const market = normalizeMarketTag(card);
  const selection = selectionSummary(card);
  const line = lineSummary(card);
  const price = priceSummary(card);

  if (bucket === 'pass_blocked') {
    const target = [selection, line].filter(Boolean).join(' ');
    return `${market} | ${target || 'No official play'}\nReason: ${decisionReason(card)}`;
  }

  const betCore = [selection, line].filter(Boolean).join(' ').trim() || 'No official play';
  const priced = price ? `${betCore} (${price})` : betCore;
  const details = metricSummary(card);
  const why = summarizeReasoning(card);

  const lines = [`${market} | ${priced}`];
  if (details) lines.push(details);
  if (why) lines.push(`Why: ${why}`);
  return lines.join('\n');
}

function sectionLines(title, cards, bucket) {
  const lines = [title];
  if (cards.length === 0) {
    lines.push('- none');
    return lines;
  }
  cards.forEach((card) => {
    const rendered = renderDecisionLine(card, bucket)
      .split('\n')
      .map((line, index) => (index === 0 ? `- ${line}` : `  ${line}`));
    lines.push(...rendered);
  });
  return lines;
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
          AND g.game_time_utc IS NOT NULL
          AND datetime(g.game_time_utc) > datetime('now')
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
  const filtered = prioritizeClearPlays(cards.filter(isDisplayableWebhookCard));
  const byGame = new Map();

  for (const card of filtered) {
    const key = `${card.gameId || card.matchup || card.id}`;
    if (!byGame.has(key)) byGame.set(key, []);
    byGame.get(key).push(card);
  }

  const snapshotEt = formatEtTime(now);
  const gameEntries = Array.from(byGame.values()).sort((left, right) => {
    const leftTime = Date.parse(left[0]?.gameTimeUtc || '') || 0;
    const rightTime = Date.parse(right[0]?.gameTimeUtc || '') || 0;
    return leftTime - rightTime;
  });

  const messages = [];
  const sectionCounts = { official: 0, lean: 0, passBlocked: 0 };

  for (const gameCards of gameEntries) {
    const seed = gameCards[0] || {};
    const official = gameCards.filter((card) => classifyDecisionBucket(card) === 'official');
    const leans = gameCards.filter((card) => classifyDecisionBucket(card) === 'lean');
    const passBlocked = gameCards.filter((card) => classifyDecisionBucket(card) === 'pass_blocked');

    sectionCounts.official += official.length;
    sectionCounts.lean += leans.length;
    sectionCounts.passBlocked += passBlocked.length;

    const league = normalizeToken(seed?.payloadData?.league || seed?.payloadData?.competition || seed?.payloadData?.league_key || seed?.sport || 'LEAGUE');
    const startEt = formatEtTime(seed?.gameTimeUtc);
    const header = [
      `${sportLabel(seed?.sport)} | ${league} | ${startEt}`,
      `${seed.matchup || 'Unknown matchup'}`,
      `Snapshot: ${snapshotEt}`,
      '',
      ...sectionLines('🟢 OFFICIAL', official, 'official'),
      '',
      ...sectionLines('🟡 LEANS', leans, 'lean'),
      '',
      ...sectionLines('⚪ PASS / BLOCKED', passBlocked, 'pass_blocked'),
    ];

    if (official.length === 0 && leans.length > 0) {
      header.push('', '🧠 NOTES', '- Leans only. No forced official play.');
    }

    messages.push(header.join('\n'));
  }

  const lines = [
    `Cheddar cards snapshot (${now.toISOString()})`,
    `Games: ${messages.length} | Rows: ${filtered.length} | Official: ${sectionCounts.official} | Lean: ${sectionCounts.lean} | Pass/Blocked: ${sectionCounts.passBlocked}`,
  ];

  return {
    content: lines.join('\n'),
    messages,
    totalCards: filtered.length,
    totalGames: messages.length,
    sectionCounts,
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
    const chunks = snapshot.messages.flatMap((message) => chunkDiscordContent(message, charLimit));

    if (dryRun) {
      return {
        success: true,
        dryRun: true,
        chunks: chunks.length,
        totalCards: snapshot.totalCards,
        totalGames: snapshot.totalGames,
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
  isDisplayableWebhookCard,
  isPlayerPropCard,
  isFirstPeriodCard,
  buildDiscordSnapshot,
  chunkDiscordContent,
  sendDiscordMessages,
};
