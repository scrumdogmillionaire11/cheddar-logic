'use strict';

const ET_TIME_FORMATTER = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York',
  month: 'short',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
  hour12: true,
});

function formatSigned(value) {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) {
    return 'n/a';
  }
  const numeric = Number(value);
  return `${numeric > 0 ? '+' : ''}${numeric}`;
}

function formatPercent(value) {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) {
    return 'n/a';
  }
  return `${(Number(value) * 100).toFixed(1)}%`;
}

function formatDollars(value) {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) {
    return '$0.00';
  }
  return `$${Number(value).toFixed(2)}`;
}

function formatEtTime(value) {
  const date = new Date(value || '');
  if (Number.isNaN(date.getTime())) return 'TBD ET';
  return `${ET_TIME_FORMATTER.format(date)} ET`;
}

function formatMarket(play) {
  if (!play) return 'Market unavailable';
  if (play.market_type === 'TOTAL') {
    return `${play.selection_label} (${formatSigned(play.price)})`;
  }
  if (play.market_type === 'SPREAD') {
    return `${play.selection_label} (${formatSigned(play.price)})`;
  }
  return `${play.selection_label} (${formatSigned(play.price)})`;
}

function formatPotdDiscordMessage(play) {
  const lines = [
    'Play of the Day',
    `${play.sport}: ${play.away_team} @ ${play.home_team}`,
    `Pick: ${formatMarket(play)}`,
    `Confidence: ${play.confidence_label} | Score: ${(Number(play.total_score || 0)).toFixed(3)}`,
    `Edge: ${formatPercent(play.edge_pct)} | Win Prob: ${formatPercent(play.model_win_prob)}`,
    `Wager: ${formatDollars(play.wager_amount)} of ${formatDollars(play.bankroll_at_post)} bankroll`,
    `Game Time: ${formatEtTime(play.game_time_utc)}`,
  ];

  return lines.join('\n').slice(0, 1800);
}

module.exports = {
  formatPotdDiscordMessage,
};
