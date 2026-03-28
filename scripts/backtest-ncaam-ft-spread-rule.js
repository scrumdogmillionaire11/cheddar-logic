'use strict';

const {
  getDatabase,
  closeDatabase,
} = require('../packages/data/src/db');
const {
  lookupTeamRankingsFreeThrowPct,
  getTeamRankingsFtDatasetStatus,
} = require('../packages/data/src/teamrankings-ft');

function toNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseRawData(rawData) {
  if (!rawData) return {};
  if (typeof rawData === 'object') return rawData;
  if (typeof rawData !== 'string') return {};
  try {
    return JSON.parse(rawData);
  } catch {
    return {};
  }
}

function gradeSpread({ selection, line, homeScore, awayScore }) {
  const diff =
    selection === 'HOME'
      ? homeScore + line - awayScore
      : awayScore + line - homeScore;
  if (diff > 0) return 'win';
  if (diff < 0) return 'loss';
  return 'push';
}

function computePnlUnits(result, odds) {
  if (result === 'push') return 0.0;
  if (result === 'loss') return -1.0;
  if (result !== 'win') return null;
  if (!Number.isFinite(odds) || odds === 0) return null;
  if (odds > 0) return odds / 100;
  return 100 / Math.abs(odds);
}

function resolveFtPct(raw, side, teamName) {
  const espnFt = toNumber(raw?.espn_metrics?.[side]?.metrics?.freeThrowPct);
  if (espnFt !== null) {
    return { value: espnFt, source: 'raw_data.espn_metrics' };
  }

  const fallback = lookupTeamRankingsFreeThrowPct(teamName);
  if (fallback && Number.isFinite(fallback.freeThrowPct)) {
    return { value: fallback.freeThrowPct, source: fallback.source };
  }

  return { value: null, source: null };
}

async function runBacktest() {
  const db = getDatabase();

  const rows = db
    .prepare(
      `
      WITH ranked AS (
        SELECT
          o.game_id,
          o.captured_at,
          o.total,
          o.spread_home,
          o.spread_away,
          o.spread_price_home,
          o.spread_price_away,
          g.home_team,
          g.away_team,
          o.raw_data,
          g.game_time_utc,
          gr.final_score_home,
          gr.final_score_away,
          ROW_NUMBER() OVER (
            PARTITION BY o.game_id
            ORDER BY datetime(o.captured_at) DESC
          ) AS rn
        FROM odds_snapshots o
        INNER JOIN games g ON g.game_id = o.game_id
        INNER JOIN game_results gr ON gr.game_id = o.game_id
        WHERE LOWER(o.sport) = 'ncaam'
          AND LOWER(gr.sport) = 'ncaam'
          AND LOWER(gr.status) = 'final'
          AND datetime(o.captured_at) <= datetime(g.game_time_utc)
      )
      SELECT
        game_id,
        captured_at,
        total,
        spread_home,
        spread_away,
        spread_price_home,
        spread_price_away,
        home_team,
        away_team,
        raw_data,
        final_score_home,
        final_score_away
      FROM ranked
      WHERE rn = 1
      ORDER BY game_id ASC
    `,
    )
    .all();

  let plays = 0;
  let wins = 0;
  let losses = 0;
  let pushes = 0;
  let totalPnlUnits = 0;
  let skippedNoRule = 0;
  let skippedMissingFt = 0;
  let skippedMissingSpread = 0;
  const picks = [];

  for (const row of rows) {
    const totalLine = toNumber(row.total);
    if (totalLine === null || totalLine >= 160) {
      skippedNoRule++;
      continue;
    }

    const raw = parseRawData(row.raw_data);
    const homeFt = resolveFtPct(raw, 'home', row.home_team);
    const awayFt = resolveFtPct(raw, 'away', row.away_team);
    if (homeFt.value === null || awayFt.value === null) {
      skippedMissingFt++;
      continue;
    }

    let selection = null;
    if (homeFt.value > 75 && awayFt.value < 75) {
      selection = 'HOME';
    } else if (awayFt.value > 75 && homeFt.value < 75) {
      selection = 'AWAY';
    } else {
      skippedNoRule++;
      continue;
    }

    const line =
      selection === 'HOME'
        ? toNumber(row.spread_home)
        : toNumber(row.spread_away);
    const price =
      selection === 'HOME'
        ? toNumber(row.spread_price_home)
        : toNumber(row.spread_price_away);
    if (line === null || price === null) {
      skippedMissingSpread++;
      continue;
    }

    const homeScore = toNumber(row.final_score_home);
    const awayScore = toNumber(row.final_score_away);
    if (homeScore === null || awayScore === null) {
      skippedMissingSpread++;
      continue;
    }

    const result = gradeSpread({
      selection,
      line,
      homeScore,
      awayScore,
    });
    const pnlUnits = computePnlUnits(result, price);
    if (pnlUnits === null) {
      skippedMissingSpread++;
      continue;
    }

    plays++;
    totalPnlUnits += pnlUnits;
    if (result === 'win') wins++;
    if (result === 'loss') losses++;
    if (result === 'push') pushes++;

    picks.push({
      game_id: row.game_id,
      total_line: totalLine,
      selection,
      line,
      price,
      home_ft_pct: homeFt.value,
      away_ft_pct: awayFt.value,
      home_ft_source: homeFt.source,
      away_ft_source: awayFt.source,
      result,
      pnl_units: Number(pnlUnits.toFixed(4)),
    });
  }

  const winRateExPush =
    wins + losses > 0 ? Number((wins / (wins + losses)).toFixed(4)) : null;
  const unitsPerPlay = plays > 0 ? Number((totalPnlUnits / plays).toFixed(4)) : null;
  const summary = {
    games_scanned: rows.length,
    plays,
    wins,
    losses,
    pushes,
    win_rate_ex_push: winRateExPush,
    roi_units: Number(totalPnlUnits.toFixed(4)),
    units_per_play: unitsPerPlay,
    sample_size_warning:
      plays < 100 ? `Sample size is ${plays}; treat as directional only.` : null,
    skipped: {
      no_rule_match: skippedNoRule,
      missing_ft_data: skippedMissingFt,
      missing_spread_data: skippedMissingSpread,
    },
    teamrankings_csv_status: getTeamRankingsFtDatasetStatus(),
  };

  console.log(
    JSON.stringify(
      {
        summary,
        picks_preview: picks.slice(0, 20),
      },
      null,
      2,
    ),
  );
}

runBacktest()
  .then(() => {
    closeDatabase();
  })
  .catch((error) => {
    console.error(`[Backtest:NCAAM-FT] Failed: ${error.message}`);
    console.error(error.stack);
    closeDatabase();
    process.exit(1);
  });
