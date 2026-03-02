/**
 * Resettle Historical Cards
 *
 * One-off migration script: re-grades already-settled card_results using the
 * authoritative recommendation.type field instead of the raw prediction field.
 *
 * Background: Early settlement runs used payload.prediction (the raw model
 * output) to determine win/loss direction. The logic was later corrected to
 * use payload.recommendation.type (the actual BET decision), which may differ
 * from the raw prediction. This script re-applies the correct logic to all
 * existing settled cards and updates any that produce a different result.
 *
 * Usage:
 *   node apps/worker/src/jobs/resettle_historical_cards.js            # apply changes
 *   node apps/worker/src/jobs/resettle_historical_cards.js --dry-run  # preview only
 *
 * Exit codes: 0 = success, 1 = failure
 */

'use strict';

const { getDatabase, withDb, upsertTrackingStat } = require('@cheddar-logic/data');

const DRY_RUN = process.argv.includes('--dry-run');

function parseAmericanOdds(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const normalized = trimmed.startsWith('+') ? trimmed.slice(1) : trimmed;
  const parsed = Number.parseInt(normalized, 10);
  return Number.isNaN(parsed) ? null : parsed;
}

function extractActualPlay(payloadData) {
  const recType = payloadData?.recommendation?.type;
  if (recType && recType !== 'PASS') {
    if (recType === 'ML_HOME') return { direction: 'HOME', market: 'moneyline' };
    if (recType === 'ML_AWAY') return { direction: 'AWAY', market: 'moneyline' };
    if (recType === 'SPREAD_HOME') return { direction: 'HOME', market: 'spread' };
    if (recType === 'SPREAD_AWAY') return { direction: 'AWAY', market: 'spread' };
    if (recType === 'TOTAL_OVER') return { direction: 'OVER', market: 'total' };
    if (recType === 'TOTAL_UNDER') return { direction: 'UNDER', market: 'total' };
  }
  if (recType === 'PASS') return null;

  // Fallback: no recommendation.type present — use raw prediction (legacy cards)
  const prediction = payloadData?.prediction;
  if (!prediction || prediction === 'NEUTRAL') return null;
  const betType = (payloadData?.recommended_bet_type || 'moneyline').toLowerCase();
  return { direction: prediction, market: betType };
}

function pickBetOdds(payloadData, direction, market) {
  const oddsContext = payloadData?.odds_context || null;
  const marketData = payloadData?.market || null;

  if (market === 'spread' || market === 'puck_line') {
    const spreadOdds = direction === 'HOME'
      ? (oddsContext?.spread_home_odds ?? oddsContext?.h2h_home ?? -110)
      : (oddsContext?.spread_away_odds ?? oddsContext?.h2h_away ?? -110);
    return parseAmericanOdds(spreadOdds);
  }

  const homeOdds = parseAmericanOdds(oddsContext?.h2h_home ?? oddsContext?.moneyline_home ?? null)
    ?? parseAmericanOdds(marketData?.moneyline_home ?? null);
  const awayOdds = parseAmericanOdds(oddsContext?.h2h_away ?? oddsContext?.moneyline_away ?? null)
    ?? parseAmericanOdds(marketData?.moneyline_away ?? null);

  if (direction === 'HOME') return homeOdds;
  if (direction === 'AWAY') return awayOdds;
  return null;
}

function computePnlUnits(result, odds) {
  if (result === 'push') return 0.0;
  if (result === 'loss') return -1.0;
  if (result !== 'win') return null;
  if (!Number.isFinite(odds) || odds === 0) return null;
  return odds > 0 ? odds / 100 : 100 / Math.abs(odds);
}

function resolveResult(direction, homeScore, awayScore, payloadData) {
  if (direction === 'HOME') {
    if (homeScore > awayScore) return 'win';
    if (homeScore < awayScore) return 'loss';
    return 'push';
  }
  if (direction === 'AWAY') {
    if (awayScore > homeScore) return 'win';
    if (awayScore < homeScore) return 'loss';
    return 'push';
  }
  if (direction === 'OVER' || direction === 'UNDER') {
    const marketTotal = payloadData?.odds_context?.total
      ?? payloadData?.driver?.inputs?.market_total
      ?? null;
    if (!Number.isFinite(Number(marketTotal))) return null; // can't resolve
    const line = Number(marketTotal);
    const actualTotal = homeScore + awayScore;
    if (actualTotal > line) return direction === 'OVER' ? 'win' : 'loss';
    if (actualTotal < line) return direction === 'UNDER' ? 'win' : 'loss';
    return 'push';
  }
  return null;
}

async function resettleHistoricalCards() {
  console.log('[Resettle] Starting historical re-settlement');
  if (DRY_RUN) console.log('[Resettle] DRY_RUN mode — no DB writes will occur');

  return withDb(async () => {
    const db = getDatabase();

    // Fetch all settled cards that have final game scores available
    const rows = db.prepare(`
      SELECT
        cr.id AS result_id,
        cr.card_id,
        cr.game_id,
        cr.sport,
        cr.result AS current_result,
        cr.pnl_units AS current_pnl,
        cp.payload_data,
        gr.final_score_home,
        gr.final_score_away
      FROM card_results cr
      INNER JOIN game_results gr ON cr.game_id = gr.game_id
      INNER JOIN card_payloads cp ON cr.card_id = cp.id
      WHERE cr.status = 'settled'
        AND gr.status = 'final'
    `).all();

    console.log(`[Resettle] Found ${rows.length} settled card_results to evaluate`);

    let checked = 0;
    let changed = 0;
    let skipped = 0;

    for (const row of rows) {
      checked++;

      let payloadData;
      try {
        payloadData = typeof row.payload_data === 'string'
          ? JSON.parse(row.payload_data)
          : row.payload_data;
      } catch {
        console.warn(`[Resettle] Failed to parse payload for card ${row.card_id} — skipping`);
        skipped++;
        continue;
      }

      const actualPlay = extractActualPlay(payloadData);
      if (!actualPlay) {
        skipped++;
        continue;
      }

      const { direction, market } = actualPlay;
      const homeScore = Number(row.final_score_home) || 0;
      const awayScore = Number(row.final_score_away) || 0;

      const newResult = resolveResult(direction, homeScore, awayScore, payloadData);
      if (!newResult) {
        console.warn(`[Resettle] Could not resolve result for card ${row.card_id} — skipping`);
        skipped++;
        continue;
      }

      let newPnl;
      if (direction === 'OVER' || direction === 'UNDER') {
        newPnl = computePnlUnits(newResult, -110);
      } else {
        const odds = pickBetOdds(payloadData, direction, market);
        newPnl = computePnlUnits(newResult, odds);
      }

      const resultChanged = newResult !== row.current_result;
      const pnlChanged = newPnl !== row.current_pnl
        && !(newPnl === null && row.current_pnl === null)
        && Math.abs((newPnl ?? 0) - (row.current_pnl ?? 0)) > 0.0001;

      if (resultChanged || pnlChanged) {
        changed++;
        console.log(
          `[Resettle] ${DRY_RUN ? '[DRY] ' : ''}Card ${row.card_id} (${row.sport}): ` +
          `${direction} (${market}) | ` +
          `result: ${row.current_result} → ${newResult} | ` +
          `pnl: ${row.current_pnl} → ${newPnl}`
        );

        if (!DRY_RUN) {
          db.prepare(`
            UPDATE card_results
            SET result = ?, pnl_units = ?
            WHERE id = ?
          `).run(newResult, newPnl, row.result_id);
        }
      }
    }

    console.log(`[Resettle] Evaluation complete — checked: ${checked}, changed: ${changed}, skipped: ${skipped}`);

    if (changed > 0 && !DRY_RUN) {
      // Re-aggregate tracking_stats from scratch
      console.log('[Resettle] Re-aggregating tracking_stats...');

      const aggregateRows = db.prepare(`
        SELECT sport, result, COUNT(*) AS count, SUM(pnl_units) AS total_pnl
        FROM card_results
        WHERE status = 'settled'
        GROUP BY sport, result
      `).all();

      const sportStats = {};
      for (const row of aggregateRows) {
        const sport = row.sport;
        if (!sportStats[sport]) {
          sportStats[sport] = { wins: 0, losses: 0, pushes: 0, totalPnl: 0 };
        }
        const count = Number(row.count) || 0;
        const pnl = Number(row.total_pnl) || 0;
        if (row.result === 'win') { sportStats[sport].wins += count; sportStats[sport].totalPnl += pnl; }
        else if (row.result === 'loss') { sportStats[sport].losses += count; sportStats[sport].totalPnl += pnl; }
        else if (row.result === 'push') { sportStats[sport].pushes += count; sportStats[sport].totalPnl += pnl; }
      }

      for (const [sport, stats] of Object.entries(sportStats)) {
        const { wins, losses, pushes, totalPnl } = stats;
        const total = wins + losses + pushes;
        upsertTrackingStat({
          id: `stat-${sport}-all-alltime`,
          statKey: `${sport}|moneyline|all|all|all|alltime`,
          sport,
          marketType: 'moneyline',
          direction: 'all',
          confidenceTier: 'all',
          driverKey: 'all',
          timePeriod: 'alltime',
          totalCards: total,
          settledCards: total,
          wins,
          losses,
          pushes,
          totalPnlUnits: totalPnl,
          winRate: (wins + losses) > 0 ? wins / (wins + losses) : 0,
          avgPnlPerCard: total > 0 ? totalPnl / total : 0,
          confidenceCalibration: null,
          metadata: { computedAt: new Date().toISOString() }
        });
        console.log(`[Resettle] Updated tracking_stat for ${sport}: ${wins}W / ${losses}L / ${pushes}P`);
      }
    }

    if (DRY_RUN && changed > 0) {
      console.log(`[Resettle] DRY_RUN complete — ${changed} card(s) would be updated. Re-run without --dry-run to apply.`);
    } else if (changed === 0) {
      console.log('[Resettle] No changes needed — all settled cards already match the updated logic.');
    } else {
      console.log(`[Resettle] Done — ${changed} card(s) updated.`);
    }

    return { success: true, checked, changed, skipped };
  });
}

if (require.main === module) {
  resettleHistoricalCards()
    .then(result => {
      process.exit(result.success ? 0 : 1);
    })
    .catch(error => {
      console.error('[Resettle] Unhandled error:', error);
      process.exit(1);
    });
}

module.exports = { resettleHistoricalCards };
