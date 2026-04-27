'use strict';

const { normalizeMarketType } = require('@cheddar-logic/data');
const { resolveNormalizedDecisionStatus } = require('@cheddar-logic/data/src');

function toUpperToken(value) {
  if (value === null || value === undefined) return '';
  return String(value).trim().toUpperCase();
}

function toFiniteNumberOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function resolveStrictStatus(payloadData) {
  return resolveNormalizedDecisionStatus(payloadData);
}

function resolveExecutionStatus(payloadData) {
  return toUpperToken(
    payloadData?.execution_status ??
      payloadData?.play?.execution_status ??
      payloadData?._publish_state?.execution_status,
  );
}

function isExecutableMlbFullGameLean(row, payloadData) {
  const cardType = String(row.card_type || '').trim().toLowerCase();
  if (cardType !== 'mlb-full-game' && cardType !== 'mlb-full-game-ml') {
    return false;
  }
  if (resolveStrictStatus(payloadData) !== 'LEAN') return false;
  if (resolveExecutionStatus(payloadData) !== 'EXECUTABLE') return false;

  const marketType = normalizeMarketType(
    row.market_type ?? payloadData?.market_type ?? payloadData?.recommended_bet_type,
  );
  const selection = toUpperToken(
    row.selection ?? payloadData?.selection?.side ?? payloadData?.selection,
  );
  const line = toFiniteNumberOrNull(row.line ?? payloadData?.line);
  const odds = toFiniteNumberOrNull(row.locked_price ?? payloadData?.price);

  if (marketType === 'MONEYLINE') {
    return (selection === 'HOME' || selection === 'AWAY') && odds !== null;
  }
  if (marketType === 'TOTAL') {
    return (
      (selection === 'OVER' || selection === 'UNDER') &&
      line !== null &&
      odds !== null
    );
  }
  return false;
}

module.exports = {
  isExecutableMlbFullGameLean,
  resolveExecutionStatus,
  resolveStrictStatus,
};