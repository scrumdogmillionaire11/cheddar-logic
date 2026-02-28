/**
 * Decision helpers for card display (dedupe, primary play, contributors, risks).
 */

const TIER_RANK = { BEST: 3, SUPER: 2, WATCH: 1 };
const DIRECTION_OPPOSITE = { HOME: 'AWAY', AWAY: 'HOME', OVER: 'UNDER', UNDER: 'OVER' };

function normalizeText(value) {
  if (typeof value !== 'string') return '';
  return value.trim();
}

function buildDriverHash(driver) {
  const note = normalizeText(driver.note);
  return `${driver.key}|${driver.market}|${driver.direction}|${note}`;
}

function isStrongerDriver(next, current) {
  const nextRank = TIER_RANK[next.tier] || 0;
  const currentRank = TIER_RANK[current.tier] || 0;
  if (nextRank !== currentRank) return nextRank > currentRank;

  const nextConfidence = typeof next.confidence === 'number' ? next.confidence : -1;
  const currentConfidence = typeof current.confidence === 'number' ? current.confidence : -1;
  if (nextConfidence !== currentConfidence) return nextConfidence > currentConfidence;

  return false;
}

export function deduplicateDrivers(drivers) {
  const driverMap = new Map();

  for (const driver of drivers) {
    const hash = buildDriverHash(driver);
    const existing = driverMap.get(hash);

    if (!existing) {
      driverMap.set(hash, driver);
      continue;
    }

    if (isStrongerDriver(driver, existing)) {
      driverMap.set(hash, driver);
    }
  }

  return Array.from(driverMap.values());
}

function sortDrivers(drivers) {
  return [...drivers].sort((a, b) => {
    const rankDiff = (TIER_RANK[b.tier] || 0) - (TIER_RANK[a.tier] || 0);
    if (rankDiff !== 0) return rankDiff;

    const aConfidence = typeof a.confidence === 'number' ? a.confidence : -1;
    const bConfidence = typeof b.confidence === 'number' ? b.confidence : -1;
    return bConfidence - aConfidence;
  });
}

function isSideIntentDriver(driver) {
  const text = `${driver.key} ${driver.cardTitle} ${driver.note}`.toLowerCase();
  return (
    text.includes('projection') ||
    text.includes('rest') ||
    text.includes('matchup') ||
    text.includes('nba projection') ||
    text.includes('nba rest') ||
    text.includes('nba matchup') ||
    text.includes('ncaam projection') ||
    text.includes('ncaam rest') ||
    text.includes('ncaam matchup')
  );
}

function isRiskOnlyDriver(driver) {
  const text = `${driver.key} ${driver.cardTitle} ${driver.note}`.toLowerCase();
  return text.includes('blowout risk') || (driver.market === 'RISK' && text.includes('blowout'));
}

function deriveStatus(card, drivers) {
  if (card.expressionChoice && card.expressionChoice.status) {
    return card.expressionChoice.status;
  }

  const hasBestNonNeutral = drivers.some(
    (driver) => driver.tier === 'BEST' && driver.direction !== 'NEUTRAL'
  );
  if (hasBestNonNeutral) return 'FIRE';

  const hasWatchOrSuper = drivers.some(
    (driver) =>
      (driver.tier === 'WATCH' || driver.tier === 'SUPER') && driver.direction !== 'NEUTRAL'
  );
  if (hasWatchOrSuper) return 'WATCH';

  return 'PASS';
}

function formatLine(value) {
  if (value === null || value === undefined) return '--';
  return value > 0 ? `+${value}` : `${value}`;
}

function buildPickString(primary, card, odds) {
  if (!primary || primary.direction === 'NEUTRAL') return 'NO PLAY';

  const direction = primary.direction;
  const market = primary.market;

  if (market === 'ML') {
    const price = direction === 'HOME' ? odds?.h2hHome : odds?.h2hAway;
    return `${direction} ${formatLine(price)}`.trim();
  }

  if (market === 'SPREAD') {
    const line = direction === 'HOME' ? odds?.spreadHome : odds?.spreadAway;
    return `${direction} ${formatLine(line)}`.trim();
  }

  if (market === 'TOTAL') {
    const line = odds?.total;
    if (direction === 'OVER' || direction === 'UNDER') {
      return `${direction === 'OVER' ? 'Over' : 'Under'} ${line ?? '--'}`.trim();
    }
    return `Total ${line ?? '--'}`.trim();
  }

  return `${direction} ${market}`.trim();
}

function deriveRiskCodes(card, drivers) {
  const codes = new Set();
  const tags = Array.isArray(card.tags) ? card.tags : [];

  if (tags.includes('has_risk_fragility') || tags.includes('has_risk_key_number')) {
    codes.add('KEY_NUMBER_FRAGILITY');
  }
  if (tags.includes('has_risk_blowout')) {
    codes.add('BLOWOUT_RISK');
  }
  if (tags.includes('has_low_coverage')) {
    codes.add('LOW_COVERAGE');
  }
  if (tags.includes('stale_5m') || tags.includes('stale_30m')) {
    codes.add('STALE_ODDS');
  }
  if (tags.includes('has_driver_contradiction')) {
    codes.add('CONFLICT_HIGH');
  }

  if (codes.size > 0) return Array.from(codes);

  const allText = drivers.map((d) => `${d.cardTitle} ${d.note}`.toLowerCase()).join(' ');
  if (allText.includes('fragility') || allText.includes('key number')) {
    codes.add('KEY_NUMBER_FRAGILITY');
  }
  if (allText.includes('blowout')) {
    codes.add('BLOWOUT_RISK');
  }
  if (allText.includes('low coverage') || allText.includes('limited data')) {
    codes.add('LOW_COVERAGE');
  }
  if (allText.includes('stale odds') || allText.includes('stale')) {
    codes.add('STALE_ODDS');
  }
  if (allText.includes('conflict')) {
    codes.add('CONFLICT_HIGH');
  }

  return Array.from(codes);
}

function getWhyReason(status, riskCodes) {
  if (status === 'PASS') return 'NO_EDGE';
  if (riskCodes.length > 0) return riskCodes[0];
  return 'EDGE_FOUND';
}

function selectPrimaryPlay(card, odds, drivers) {
  if (card.expressionChoice && card.expressionChoice.pick) {
    return {
      source: 'expressionChoice',
      market: card.expressionChoice.chosenMarket,
      status: card.expressionChoice.status,
      pick: card.expressionChoice.pick,
      direction: null,
      tier: null,
      confidence: null,
    };
  }

  const nonNeutral = drivers.filter(
    (driver) => driver.direction !== 'NEUTRAL' && !isRiskOnlyDriver(driver)
  );
  if (nonNeutral.length === 0) {
    return {
      source: 'none',
      market: 'UNKNOWN',
      status: 'PASS',
      pick: 'NO PLAY',
      direction: null,
      tier: null,
      confidence: null,
    };
  }

  const sideCompatible = nonNeutral.filter(
    (driver) =>
      (driver.direction === 'HOME' || driver.direction === 'AWAY' || driver.direction === 'OVER' || driver.direction === 'UNDER') &&
      (driver.market === 'ML' || driver.market === 'SPREAD' || driver.market === 'TOTAL' || driver.market === 'UNKNOWN' || isSideIntentDriver(driver))
  );

  const strongest = sortDrivers(sideCompatible.length > 0 ? sideCompatible : nonNeutral)[0];
  const hasMLOdds = odds && (odds.h2hHome !== null || odds.h2hAway !== null);
  const resolvedMarket =
    strongest.market === 'UNKNOWN' &&
    (strongest.direction === 'HOME' || strongest.direction === 'AWAY') &&
    hasMLOdds
      ? 'ML'
      : strongest.market;
  const status = deriveStatus(card, drivers);
  const pick = buildPickString({ ...strongest, market: resolvedMarket }, card, odds);

  return {
    source: 'drivers',
    market: resolvedMarket,
    status,
    pick,
    direction: strongest.direction,
    tier: strongest.tier,
    confidence: strongest.confidence ?? null,
  };
}

function pickTopContributors(drivers, primary) {
  if (!drivers.length) return [];

  const sorted = sortDrivers(drivers);
  const nonNeutral = sorted.filter((driver) => driver.direction !== 'NEUTRAL');

  if (!primary || !primary.direction || primary.direction === 'NEUTRAL') {
    return nonNeutral.slice(0, 3).map((driver) => ({ driver, polarity: 'neutral' }));
  }

  const opposite = DIRECTION_OPPOSITE[primary.direction];
  const pro = nonNeutral.filter((driver) => driver.direction === primary.direction);
  const contra = nonNeutral.filter((driver) => driver.direction === opposite);
  const neutral = sorted.filter((driver) => driver.direction === 'NEUTRAL');

  const selected = [];
  const used = new Set();

  for (const driver of pro.slice(0, 2)) {
    selected.push({ driver, polarity: 'pro' });
    used.add(driver);
  }

  if (selected.length < 2) {
    for (const driver of nonNeutral) {
      if (selected.length >= 2) break;
      if (used.has(driver)) continue;
      selected.push({ driver, polarity: 'pro' });
      used.add(driver);
    }
  }

  if (selected.length < 3 && contra.length > 0) {
    const driver = contra.find((item) => !used.has(item));
    if (driver) {
      selected.push({ driver, polarity: 'contra' });
      used.add(driver);
    }
  }

  if (selected.length < 3 && contra.length === 0 && neutral.length > 0) {
    const driver = neutral.find((item) => !used.has(item));
    if (driver) {
      selected.push({ driver, polarity: 'contra' });
      used.add(driver);
    }
  }

  if (selected.length < 3) {
    for (const driver of nonNeutral) {
      if (selected.length >= 3) break;
      if (used.has(driver)) continue;
      selected.push({ driver, polarity: 'neutral' });
      used.add(driver);
    }
  }

  return selected;
}

export function getCardDecisionModel(card, odds) {
  const baseDrivers = Array.isArray(card.drivers) ? card.drivers : [];
  const drivers = deduplicateDrivers(baseDrivers);
  const status = deriveStatus(card, drivers);
  const primaryPlay = selectPrimaryPlay(card, odds, drivers);
  const riskCodes = deriveRiskCodes(card, drivers);
  const whyReason = getWhyReason(status, riskCodes);
  const topContributors = pickTopContributors(drivers, primaryPlay);

  return {
    status,
    primaryPlay,
    whyReason,
    riskCodes,
    topContributors,
    allDrivers: drivers,
  };
}
