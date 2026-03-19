'use strict';
require('dotenv').config();

const { v4: uuidV4 } = require('uuid');
const {
  insertJobRun,
  markJobRunSuccess,
  markJobRunFailure,
  listPendingSoccerClvEntries,
  getLatestOdds,
  settleClvEntry,
  withDb,
} = require('@cheddar-logic/data');

const JOB_NAME = 'settle_soccer_clv';
const DEFAULT_MIN_AGE_HOURS = Number(
  process.env.SOCCER_CLV_SETTLEMENT_DELAY_HOURS || 24,
);

function toImpliedProbability(americanOdds) {
  if (!Number.isFinite(americanOdds) || americanOdds === 0) return null;
  return americanOdds < 0
    ? -americanOdds / (-americanOdds + 100)
    : 100 / (americanOdds + 100);
}

function parseRawData(rawData) {
  if (!rawData) return null;
  if (typeof rawData === 'object') return rawData;
  if (typeof rawData !== 'string') return null;
  try {
    return JSON.parse(rawData);
  } catch {
    return null;
  }
}

function deriveMoneylineImpliedProbs(h2hHome, h2hAway) {
  const pHome = toImpliedProbability(h2hHome);
  const pAway = toImpliedProbability(h2hAway);
  if (Number.isFinite(pHome) && Number.isFinite(pAway) && pHome + pAway > 0) {
    const total = pHome + pAway;
    return {
      home: Number((pHome / total).toFixed(4)),
      away: Number((pAway / total).toFixed(4)),
    };
  }
  return {
    home: Number.isFinite(pHome) ? Number(pHome.toFixed(4)) : null,
    away: Number.isFinite(pAway) ? Number(pAway.toFixed(4)) : null,
  };
}

function deriveTotalImpliedProb({ overPrice, underPrice, selection }) {
  const over = toImpliedProbability(overPrice);
  const under = toImpliedProbability(underPrice);
  const side = String(selection || '').trim().toUpperCase();
  if (Number.isFinite(over) && Number.isFinite(under) && over + under > 0) {
    const total = over + under;
    if (side === 'UNDER') return Number((under / total).toFixed(4));
    if (side === 'OVER') return Number((over / total).toFixed(4));
  }
  if (side === 'UNDER' && Number.isFinite(under)) return Number(under.toFixed(4));
  if (side === 'OVER' && Number.isFinite(over)) return Number(over.toFixed(4));
  return null;
}

function resolveClosingOdds(entry, oddsSnapshot) {
  if (!entry || !oddsSnapshot) return { closingOdds: null, closingImpliedProb: null };

  if (entry.market_key === 'soccer_ml') {
    const closingOdds = entry.pick_side === 'AWAY'
      ? (Number.isFinite(oddsSnapshot.h2h_away) ? Math.trunc(oddsSnapshot.h2h_away) : null)
      : (Number.isFinite(oddsSnapshot.h2h_home) ? Math.trunc(oddsSnapshot.h2h_home) : null);
    const implied = deriveMoneylineImpliedProbs(oddsSnapshot.h2h_home, oddsSnapshot.h2h_away);
    const closingImpliedProb = entry.pick_side === 'AWAY' ? implied.away : implied.home;
    return { closingOdds, closingImpliedProb };
  }

  if (entry.market_key === 'soccer_game_total') {
    const payload = parseRawData(entry.payload_data) || {};
    const selection = String(entry.pick_side || payload.selection || '').toUpperCase();
    const closingOdds = selection === 'UNDER'
      ? (Number.isFinite(oddsSnapshot.total_price_under) ? Math.trunc(oddsSnapshot.total_price_under) : null)
      : (Number.isFinite(oddsSnapshot.total_price_over) ? Math.trunc(oddsSnapshot.total_price_over) : null);
    const closingImpliedProb = deriveTotalImpliedProb({
      overPrice: oddsSnapshot.total_price_over,
      underPrice: oddsSnapshot.total_price_under,
      selection,
    });
    return { closingOdds, closingImpliedProb };
  }

  if (entry.market_key === 'soccer_double_chance') {
    const rawData = parseRawData(oddsSnapshot.raw_data) || {};
    const closingOdds = Number.isFinite(rawData.dc_price) ? Math.trunc(rawData.dc_price) : null;
    const closingImpliedProb = Number.isFinite(rawData.implied_prob)
      ? Number(rawData.implied_prob.toFixed(4))
      : (Number.isFinite(closingOdds) ? Number(toImpliedProbability(closingOdds).toFixed(4)) : null);
    return { closingOdds, closingImpliedProb };
  }

  return { closingOdds: null, closingImpliedProb: null };
}

async function settleSoccerClv({ jobKey = null, dryRun = false } = {}) {
  const jobRunId = `job-${JOB_NAME}-${new Date().toISOString().split('.')[0]}-${uuidV4().slice(0, 8)}`;

  if (process.env.ENABLE_SOCCER_CLV_SETTLEMENT !== 'true') {
    console.log(`[${JOB_NAME}] Skipped — set ENABLE_SOCCER_CLV_SETTLEMENT=true to enable`);
    return { success: true, skipped: true, reason: 'not_enabled' };
  }

  if (process.env.ENABLE_CLV_LEDGER !== 'true') {
    console.log(`[${JOB_NAME}] Skipped — ENABLE_CLV_LEDGER must be true`);
    return { success: true, skipped: true, reason: 'clv_disabled' };
  }

  if (dryRun) {
    console.log(`[${JOB_NAME}] DRY_RUN — would settle soccer CLV rows older than ${DEFAULT_MIN_AGE_HOURS}h`);
    return { success: true, dryRun: true };
  }

  return withDb(async () => {
    try {
      insertJobRun(JOB_NAME, jobRunId, jobKey);

      const entries = listPendingSoccerClvEntries({
        minAgeHours: DEFAULT_MIN_AGE_HOURS,
        limit: 500,
      });

      let settled = 0;
      let skipped = 0;

      for (const entry of entries) {
        const closingSnapshot = getLatestOdds(entry.game_id);
        if (!closingSnapshot) {
          skipped += 1;
          console.warn(`[${JOB_NAME}] No closing odds snapshot for ${entry.card_id}`);
          continue;
        }

        const { closingOdds, closingImpliedProb } = resolveClosingOdds(entry, closingSnapshot);
        if (!Number.isFinite(closingImpliedProb)) {
          skipped += 1;
          console.warn(`[${JOB_NAME}] No closing implied prob for ${entry.card_id}`);
          continue;
        }

        const displayedImpliedProb = Number.isFinite(entry.displayed_implied_prob)
          ? entry.displayed_implied_prob
          : null;
        const clvPct = Number.isFinite(displayedImpliedProb)
          ? Number((closingImpliedProb - displayedImpliedProb).toFixed(4))
          : null;

        settleClvEntry({
          cardId: entry.card_id,
          closingOdds,
          closingImpliedProb,
          clvPct,
          settledAt: new Date().toISOString(),
          metadata: {
            settled_via: 'latest_odds_snapshot',
            game_result_settled_at: entry.game_result_settled_at || null,
          },
        });
        settled += 1;
      }

      markJobRunSuccess(jobRunId, { settled, skipped, scanned: entries.length });
      console.log(`[${JOB_NAME}] Done: settled=${settled}, skipped=${skipped}, scanned=${entries.length}`);
      return { success: true, settled, skipped, scanned: entries.length };
    } catch (error) {
      console.error(`[${JOB_NAME}] Job failed: ${error.message}`);
      try {
        markJobRunFailure(jobRunId, { error: error.message });
      } catch {}
      return { success: false, error: error.message };
    }
  });
}

if (require.main === module) {
  const dryRun = process.argv.includes('--dry-run');
  settleSoccerClv({ dryRun })
    .then((result) => process.exit(result.success ? 0 : 1))
    .catch((error) => {
      console.error(error);
      process.exit(1);
    });
}

module.exports = {
  settleSoccerClv,
  resolveClosingOdds,
};
