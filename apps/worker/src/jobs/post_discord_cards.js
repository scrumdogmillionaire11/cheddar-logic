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
  createJob,
} = require('@cheddar-logic/data');

const JOB_NAME = 'post_discord_cards';
const DEFAULT_CHAR_LIMIT = 1800;
const DISCORD_HARD_LIMIT = 2000;
const DEFAULT_MAX_ROWS = 300;
// Leans with |edge| below this are suppressed — rounding error, not signal
// Override with env DISCORD_MIN_LEAN_EDGE (e.g. '0.2')
const MIN_LEAN_EDGE_ABS = Number(process.env.DISCORD_MIN_LEAN_EDGE ?? 0.15);
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

// Prevents [object Object] leaking into Discord output
function safeScalar(val) {
  if (val === null || val === undefined) return null;
  if (typeof val === 'object') return null;
  const str = String(val).trim();
  return str || null;
}

// Human-readable reason codes — no internal tokens exposed to Discord
const REASON_CODE_LABELS = {
  EDGE_VERIFICATION_REQUIRED: 'Line unstable — waiting for confirmation',
  MODEL_PROB_MISSING:          'Model incomplete — no play',
  PASS_NO_EDGE:                'No edge',
  NO_EDGE_AT_PRICE:            'Price too sharp',
  PASS_LOW_CONFIDENCE:         'Low confidence',
  PASS_SHARP_MONEY_OPPOSITE:   'Sharp money against — no play',
  GATE_GOALIE_UNCONFIRMED:     'Goalie not confirmed',
  GATE_LINE_MOVEMENT:          'Line moved — re-evaluating',
  BLOCK_INJURY_RISK:           'Injury risk flag',
  BLOCK_STALE_DATA:            'Data stale — no play',
};

function humanReason(card) {
  const payload = card?.payloadData || {};
  const codes = [
    normalizeToken(payload?.pass_reason_code),
    normalizeToken(payload?.pass_reason),
    ...(Array.isArray(payload?.reason_codes) ? payload.reason_codes.map(normalizeToken) : []),
    normalizeToken(payload?.blocked_reason_code),
  ].filter(Boolean);

  for (const code of codes) {
    if (REASON_CODE_LABELS[code]) return REASON_CODE_LABELS[code];
  }
  return 'No edge';
}

const TEAM_ABBREVIATIONS = {
  'arizona cardinals': 'ARI',   'atlanta falcons': 'ATL',    'baltimore ravens': 'BAL',
  'buffalo bills': 'BUF',       'carolina panthers': 'CAR',  'chicago bears': 'CHI',
  'chicago blackhawks': 'CHI',  'chicago bulls': 'CHI',      'chicago cubs': 'CHC',
  'chicago white sox': 'CWS',   'cincinnati bengals': 'CIN', 'cleveland browns': 'CLE',
  'cleveland guardians': 'CLE', 'colorado avalanche': 'COL', 'colorado rockies': 'COL',
  'dallas cowboys': 'DAL',      'dallas mavericks': 'DAL',   'dallas stars': 'DAL',
  'denver broncos': 'DEN',      'denver nuggets': 'DEN',     'detroit lions': 'DET',
  'detroit red wings': 'DET',   'detroit pistons': 'DET',    'edmonton oilers': 'EDM',
  'florida panthers': 'FLA',    'golden state warriors': 'GSW', 'green bay packers': 'GB',
  'houston astros': 'HOU',      'houston rockets': 'HOU',    'houston texans': 'HOU',
  'indianapolis colts': 'IND',  'jacksonville jaguars': 'JAX', 'kansas city chiefs': 'KC',
  'kansas city royals': 'KC',   'las vegas raiders': 'LV',   'los angeles chargers': 'LAC',
  'los angeles clippers': 'LAC','los angeles dodgers': 'LAD', 'los angeles kings': 'LAK',
  'los angeles lakers': 'LAL',  'los angeles rams': 'LAR',   'los angeles angels': 'LAA',
  'miami dolphins': 'MIA',      'miami heat': 'MIA',         'miami marlins': 'MIA',
  'minnesota timberwolves': 'MIN','minnesota twins': 'MIN',  'minnesota vikings': 'MIN',
  'minnesota wild': 'MIN',      'nashville predators': 'NSH', 'new england patriots': 'NE',
  'new jersey devils': 'NJD',   'new orleans pelicans': 'NOP', 'new orleans saints': 'NO',
  'new york giants': 'NYG',     'new york islanders': 'NYI', 'new york jets': 'NYJ',
  'new york knicks': 'NYK',     'new york mets': 'NYM',      'new york rangers': 'NYR',
  'new york yankees': 'NYY',    'oklahoma city thunder': 'OKC', 'ottawa senators': 'OTT',
  'philadelphia eagles': 'PHI', 'philadelphia flyers': 'PHI', 'philadelphia phillies': 'PHI',
  'philadelphia 76ers': 'PHI',  'phoenix coyotes': 'ARI',    'phoenix suns': 'PHX',
  'pittsburgh penguins': 'PIT', 'pittsburgh pirates': 'PIT', 'pittsburgh steelers': 'PIT',
  'portland trail blazers': 'POR', 'sacramento kings': 'SAC', 'san antonio spurs': 'SAS',
  'san jose sharks': 'SJS',     'seattle kraken': 'SEA',     'seattle mariners': 'SEA',
  'seattle seahawks': 'SEA',    'st. louis blues': 'STL',    'st. louis cardinals': 'STL',
  'tampa bay buccaneers': 'TB', 'tampa bay lightning': 'TB', 'tampa bay rays': 'TB',
  'tennessee titans': 'TEN',    'toronto maple leafs': 'TOR', 'toronto raptors': 'TOR',
  'toronto blue jays': 'TOR',   'utah jazz': 'UTA',          'utah hockey club': 'UTA',
  'vancouver canucks': 'VAN',   'washington capitals': 'WSH', 'washington commanders': 'WAS',
  'washington nationals': 'WSH','washington wizards': 'WSH', 'winnipeg jets': 'WPG',
  // Additional common abbreviations
  'calgary flames': 'CGY',     'buffalo sabres': 'BUF',     'anaheim ducks': 'ANA',
  'arizona coyotes': 'ARI',    'columbus blue jackets': 'CBJ', 'montreal canadiens': 'MTL',
  'boston bruins': 'BOS',      'carolina hurricanes': 'CAR',
};

// Mascot/nickname for each team — combined with abbreviation (e.g. "STL Blues")
const TEAM_NICKNAMES = {
  'arizona cardinals': 'Cardinals',    'atlanta falcons': 'Falcons',        'baltimore ravens': 'Ravens',
  'buffalo bills': 'Bills',            'buffalo sabres': 'Sabres',          'carolina panthers': 'Panthers',
  'carolina hurricanes': 'Hurricanes', 'chicago bears': 'Bears',            'chicago blackhawks': 'Blackhawks',
  'chicago bulls': 'Bulls',            'chicago cubs': 'Cubs',              'chicago white sox': 'White Sox',
  'cincinnati bengals': 'Bengals',     'cleveland browns': 'Browns',        'cleveland guardians': 'Guardians',
  'colorado avalanche': 'Avalanche',   'colorado rockies': 'Rockies',       'dallas cowboys': 'Cowboys',
  'dallas mavericks': 'Mavericks',     'dallas stars': 'Stars',             'denver broncos': 'Broncos',
  'denver nuggets': 'Nuggets',         'detroit lions': 'Lions',            'detroit red wings': 'Red Wings',
  'detroit pistons': 'Pistons',        'edmonton oilers': 'Oilers',         'florida panthers': 'Panthers',
  'golden state warriors': 'Warriors', 'green bay packers': 'Packers',      'houston astros': 'Astros',
  'houston rockets': 'Rockets',        'houston texans': 'Texans',          'indianapolis colts': 'Colts',
  'jacksonville jaguars': 'Jaguars',   'kansas city chiefs': 'Chiefs',      'kansas city royals': 'Royals',
  'las vegas raiders': 'Raiders',      'los angeles chargers': 'Chargers',  'los angeles clippers': 'Clippers',
  'los angeles dodgers': 'Dodgers',    'los angeles kings': 'Kings',        'los angeles lakers': 'Lakers',
  'los angeles rams': 'Rams',          'los angeles angels': 'Angels',      'miami dolphins': 'Dolphins',
  'miami heat': 'Heat',                'miami marlins': 'Marlins',          'minnesota timberwolves': 'Timberwolves',
  'minnesota twins': 'Twins',          'minnesota vikings': 'Vikings',      'minnesota wild': 'Wild',
  'nashville predators': 'Predators',  'new england patriots': 'Patriots',  'new jersey devils': 'Devils',
  'new orleans pelicans': 'Pelicans',  'new orleans saints': 'Saints',      'new york giants': 'Giants',
  'new york islanders': 'Islanders',   'new york jets': 'Jets',             'new york knicks': 'Knicks',
  'new york mets': 'Mets',             'new york rangers': 'Rangers',       'new york yankees': 'Yankees',
  'oklahoma city thunder': 'Thunder',  'ottawa senators': 'Senators',       'philadelphia eagles': 'Eagles',
  'philadelphia flyers': 'Flyers',     'philadelphia phillies': 'Phillies', 'philadelphia 76ers': '76ers',
  'phoenix coyotes': 'Coyotes',        'phoenix suns': 'Suns',              'pittsburgh penguins': 'Penguins',
  'pittsburgh pirates': 'Pirates',     'pittsburgh steelers': 'Steelers',   'portland trail blazers': 'Blazers',
  'sacramento kings': 'Kings',         'san antonio spurs': 'Spurs',        'san jose sharks': 'Sharks',
  'seattle kraken': 'Kraken',          'seattle mariners': 'Mariners',      'seattle seahawks': 'Seahawks',
  'st. louis blues': 'Blues',          'st. louis cardinals': 'Cardinals',  'tampa bay buccaneers': 'Buccaneers',
  'tampa bay lightning': 'Lightning',  'tampa bay rays': 'Rays',            'tennessee titans': 'Titans',
  'toronto maple leafs': 'Leafs',      'toronto raptors': 'Raptors',        'toronto blue jays': 'Blue Jays',
  'utah jazz': 'Jazz',                 'utah hockey club': 'Utah HC',       'vancouver canucks': 'Canucks',
  'washington capitals': 'Capitals',   'washington commanders': 'Commanders','washington nationals': 'Nationals',
  'washington wizards': 'Wizards',     'winnipeg jets': 'Jets',             'calgary flames': 'Flames',
  'anaheim ducks': 'Ducks',            'arizona coyotes': 'Coyotes',        'columbus blue jackets': 'Blue Jackets',
  'montreal canadiens': 'Canadiens',   'boston bruins': 'Bruins',           'boston celtics': 'Celtics',
  'boston red sox': 'Red Sox',
};

function abbreviateTeam(name) {
  if (!name) return '';
  const lower = String(name).toLowerCase().trim();
  const abbrev   = TEAM_ABBREVIATIONS[lower];
  const nickname = TEAM_NICKNAMES[lower];
  if (abbrev && nickname) return `${abbrev} ${nickname}`;
  if (abbrev) return abbrev;
  // Already short (≤4 chars) — assume it's already an abbreviation
  if (lower.length <= 4) return String(name).toUpperCase();
  // Generic fallback: first letter of each word, max 3 chars
  return lower.split(/\s+/).map((w) => w[0].toUpperCase()).join('').slice(0, 3);
}

function abbreviateMatchup(matchup) {
  const parts = String(matchup || '').split(' @ ');
  if (parts.length !== 2) return matchup;
  return `${abbreviateTeam(parts[0])} @ ${abbreviateTeam(parts[1])}`;
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

// Canonical game key: normalised from teams + game date so two cards for the same
// real game always land in the same bucket regardless of how game_id was stored.
function canonicalGameKey(card) {
  const matchup  = String(card?.matchup  || '').trim().toLowerCase();
  const gameDate = String(card?.gameTimeUtc || '').slice(0, 10); // YYYY-MM-DD

  // Prefer matchup+date — immune to game_id inconsistencies across card types
  if (matchup && matchup !== 'unknown') {
    const safeMatchup = matchup.replace(/\s+/g, '_').replace(/@/g, 'vs');
    // Include date only when we have it; same-day collision risk is negligible
    return gameDate ? `${safeMatchup}_${gameDate}` : safeMatchup;
  }

  const gameId = String(card?.gameId || '').trim().toLowerCase();
  if (gameId) return gameId;

  return String(card?.id || 'unknown');
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

  if (token.includes('asian_handicap') || token.includes('spread') || token.includes('handicap')) return 'Spread';
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
  if (selection) return compactToken(selection);

  // Fallback for 1P / pace cards: extract direction from one_p_model_call
  // e.g. "NHL_1P_OVER_1.5" or "NHL_1P_UNDER_PLAY"
  const onePCall = String(payload?.one_p_model_call || '').toUpperCase();
  if (onePCall.includes('_OVER') || onePCall.startsWith('OVER')) return 'OVER';
  if (onePCall.includes('_UNDER') || onePCall.startsWith('UNDER')) return 'UNDER';

  return '';
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

// Format a numeric edge value as +0.17 / -0.70 (2dp, always signed)
function formatEdgeValue(raw) {
  const num = Number(raw);
  if (!Number.isFinite(num)) return String(raw);
  const sign = num >= 0 ? '+' : '';
  return `${sign}${num.toFixed(2)}`;
}

// Extract the single best projection number for a card — shown inline on the pick line
function projectionValue(card) {
  const payload = card?.payloadData || {};
  return safeScalar(
    payload?.player_projection ??
    payload?.projected_value ??
    payload?.proj ??
    payload?.model_projection ??
    payload?.projection ??
    payload?.expected_total,
  );
}

function metricSummary(card) {
  const payload = card?.payloadData || {};
  const edgeRaw = safeScalar(payload?.edge ?? payload?.edge_pct ?? payload?.edge_over_pp);
  const edge    = edgeRaw !== null ? formatEdgeValue(edgeRaw) : null;
  const line    = safeScalar(payload?.line ?? payload?.total ?? payload?.market_line);

  // Projection is shown inline on the pick line — this row carries Line + Edge only
  const parts = [];
  if (line) parts.push(`Line: ${line}`);
  if (edge) parts.push(`Edge: ${edge}`);
  return parts.join(' | ');
}

function renderDecisionLine(card, bucket) {
  const payload = card?.payloadData || {};

  // PASS lines are never rendered individually — collapsed upstream
  if (bucket === 'pass_blocked') return null;

  if (isPlayerPropCard(card)) {
    // Strip leading action words ('Lean ', 'Fire ', 'Watch ') from prediction strings
    const rawPick = compactToken(
      payload?.prediction ||
      payload?.play?.pick_string ||
      payload?.play?.selection ||
      '',
    );
    const pickStr = rawPick.replace(/^(lean|fire|watch|hold|play)\s+/i, '').trim();
    const priceVal = priceSummary(card);
    const why = summarizeReasoning(card);

    const proj = projectionValue(card);
    const priced = pickStr
      ? (priceVal ? `${pickStr} (${priceVal})` : pickStr)
      : 'No selection';

    // Second line: projection | edge
    const edgeRawProp = safeScalar(payload?.edge ?? payload?.edge_pct ?? payload?.edge_over_pp);
    const edgeProp = edgeRawProp !== null ? formatEdgeValue(edgeRawProp) : null;
    const propMetricParts = [];
    if (proj) propMetricParts.push(proj);
    if (edgeProp) propMetricParts.push(`Edge: ${edgeProp}`);
    const propMetricsLine = propMetricParts.join(' | ');

    const lines = [`PROP | ${priced}`];
    if (propMetricsLine) lines.push(propMetricsLine);
    if (why)     lines.push(`Why: ${why}`);
    const wProp = payload?.price_staleness_warning;
    if (wProp) lines.push(`⚠️ Hard-locked at ${wProp.locked_price} — current may be ${wProp.current_candidate_price} (${wProp.delta_american} pts drift, T-${wProp.minutes_to_start}min)`);
    return lines.join('\n');
  }

  const market    = normalizeMarketTag(card);
  const selection = selectionSummary(card);
  const line      = lineSummary(card);
  const price     = priceSummary(card);

  // For TOTAL markets, require a model projection — projection-less totals have no bettor value
  if (market === 'TOTAL') {
    const hasModel = safeScalar(
      payload?.model_projection ?? payload?.model_line ?? payload?.projection ?? payload?.expected_total,
    );
    const hasEdge = safeScalar(payload?.edge ?? payload?.edge_pct);
    if (!hasModel && !hasEdge) return null;  // skip unprojected totals
  }

  const betCore = [selection, line].filter(Boolean).join(' ').trim() || 'TBD';
  const priced  = price ? `${betCore} (${price})` : betCore;
  const proj    = projectionValue(card);
  const why     = summarizeReasoning(card);

  // Second line: projection | edge (line is already embedded in the pick string)
  const edgeRaw2 = safeScalar(payload?.edge ?? payload?.edge_pct ?? payload?.edge_over_pp);
  const edgeFormatted2 = edgeRaw2 !== null ? formatEdgeValue(edgeRaw2) : null;
  const metricParts2 = [];
  if (proj) metricParts2.push(proj);
  if (edgeFormatted2) metricParts2.push(`Edge: ${edgeFormatted2}`);
  const metricsLine2 = metricParts2.join(' | ');

  const lines = [`${market} | ${priced}`];
  if (metricsLine2) lines.push(metricsLine2);
  if (why)     lines.push(`Why: ${why}`);
  const w = payload?.price_staleness_warning;
  if (w) lines.push(`⚠️ Hard-locked at ${w.locked_price} — current may be ${w.current_candidate_price} (${w.delta_american} pts drift, T-${w.minutes_to_start}min)`);
  return lines.join('\n');
}

function sectionLines(title, cards, bucket) {
  // PASS section is never rendered inline — use collapsedPassSummary instead
  if (bucket === 'pass_blocked') return [];
  if (cards.length === 0) return [];

  const renderedItems = [];
  for (const card of cards) {
    const rendered = renderDecisionLine(card, bucket);
    if (!rendered) continue;
    rendered.split('\n').forEach((line) => {
      renderedItems.push(line);
    });
  }

  // Only return the title if at least one card actually rendered
  if (renderedItems.length === 0) return [];
  return [title, ...renderedItems];
}

// One-line collapsed PASS summary — no market-by-market spam
function collapsedPassSummary(cards) {
  if (cards.length === 0) return null;
  const reasons = [...new Set(cards.map((c) => humanReason(c)).filter(Boolean))];
  const reasonStr = reasons.slice(0, 2).join('; ');
  return `⚪ PASS\n${reasonStr || 'No playable edges'}`;
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
  for (const message of messages) {
    const response = await fetchImpl(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: message }),
    });
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(`Discord webhook failed (${response.status}): ${body}`);
    }
    sent.push(true);
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
            PARTITION BY CASE
              WHEN cp.card_type IN ('nhl-player-shots', 'nhl-player-shots-1p')
                THEN cp.id
              ELSE cp.game_id || '|' || cp.card_type
            END
            ORDER BY cp.created_at DESC, cp.id DESC
          ) AS rn
        FROM card_payloads cp
        LEFT JOIN games g ON g.game_id = cp.game_id
        WHERE LOWER(cp.sport) != 'fpl'
          AND LOWER(cp.card_type) != 'potd-call'
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

// Returns true when a lean card clears the minimum edge threshold.
// Cards with NO edge data are allowed through — we don't penalise missing fields.
// For prop cards the edge is often only in the prediction string (e.g. "Edge -0.1")
// so we also try to parse it from there.
function passesLeanThreshold(card) {
  const payload = card?.payloadData || {};
  const raw = payload?.edge ?? payload?.edge_pct ?? payload?.edge_over_pp;

  if (raw !== null && raw !== undefined) {
    const val = Number(raw);
    if (Number.isFinite(val)) return Math.abs(val) >= MIN_LEAN_EDGE_ABS;
  }

  // Fallback: parse edge from prediction string ("... Edge +0.9" or "Edge: -0.4")
  const prediction = String(payload?.prediction || payload?.play?.pick_string || '');
  const edgeMatch  = prediction.match(/Edge[:\s]+([+-]?\d+\.?\d*)/i);
  if (edgeMatch) {
    const val = Number(edgeMatch[1]);
    if (Number.isFinite(val)) return Math.abs(val) >= MIN_LEAN_EDGE_ABS;
  }

  return true; // no parseable edge → allow through (don't drop unknowns)
}

function buildDiscordSnapshot({ now = new Date(), cards = [] } = {}) {
  const filtered = prioritizeClearPlays(cards.filter(isDisplayableWebhookCard));
  const byGame = new Map();

  for (const card of filtered) {
    const key = canonicalGameKey(card);
    if (!byGame.has(key)) byGame.set(key, []);
    byGame.get(key).push(card);
  }

  const snapshotEt = formatEtTime(now);
  const gameEntries = Array.from(byGame.values()).sort((left, right) => {
    const leftTime  = Date.parse(left[0]?.gameTimeUtc  || '') || 0;
    const rightTime = Date.parse(right[0]?.gameTimeUtc || '') || 0;
    return leftTime - rightTime;
  });

  const messages = [];
  const sectionCounts = { official: 0, lean: 0, passBlocked: 0 };

  for (const gameCards of gameEntries) {
    const seed        = gameCards[0] || {};
    const official    = gameCards.filter((c) => classifyDecisionBucket(c) === 'official');
    // Apply LEAN threshold — drop sub-threshold edge leans before rendering
    const leans       = gameCards
      .filter((c) => classifyDecisionBucket(c) === 'lean')
      .filter(passesLeanThreshold);
    const passBlocked = gameCards.filter((c) => classifyDecisionBucket(c) === 'pass_blocked');

    sectionCounts.official    += official.length;
    sectionCounts.lean        += leans.length;
    sectionCounts.passBlocked += passBlocked.length;

    // Hard send filter — skip games with nothing actionable
    if (official.length === 0 && leans.length === 0) continue;

    const shortMatchup = abbreviateMatchup(seed.matchup || 'Unknown');
    const startEt      = formatEtTime(seed?.gameTimeUtc);

    const headerLines = [
      '─────────────────',
      `${sportLabel(seed?.sport)} | ${startEt}`,
      shortMatchup,
      `Snapshot: ${snapshotEt}`,
    ];

    const officialLines = sectionLines('🟢 PLAY', official, 'official');
    if (officialLines.length > 0) headerLines.push('', ...officialLines);

    const leanLines = sectionLines('🟡 Slight Edge', leans, 'lean');
    if (leanLines.length > 0) headerLines.push('', ...leanLines);

    // PASS block only when nothing was rendered — avoids contradicting a lean
    const hasRenderedContent = officialLines.length > 0 || leanLines.length > 0;
    if (!hasRenderedContent) {
      continue; // no plays, no leans rendered — skip entirely (dead game to bettor)
    }

    headerLines.push('─────────────────');
    messages.push(headerLines.join('\n'));
  }

  const lines = [
    `Cheddar snapshot (${now.toISOString()})`,
    `Games posted: ${messages.length} | Cards: ${filtered.length} | Play: ${sectionCounts.official} | Lean: ${sectionCounts.lean}`,
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
    console.log(
      `[post-discord-cards] Skipping: ENABLE_DISCORD_CARD_WEBHOOKS is not 'true' — set it to enable Discord posts`,
    );
    return {
      success: true,
      skipped: true,
      reason: 'disabled',
      message: 'ENABLE_DISCORD_CARD_WEBHOOKS != true',
    };
  }

  if (!webhookUrl) {
    console.log(
      `[post-discord-cards] Skipping: DISCORD_CARD_WEBHOOK_URL is unset — provide a webhook URL to enable Discord posts`,
    );
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
        totalGames: snapshot.totalGames,
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
  createJob(JOB_NAME, async ({ dryRun }) => {
    const result = await postDiscordCards({ dryRun });
    if (!result) {
      throw new Error('postDiscordCards returned no result');
    }
    if (result.skipped) {
      console.log(`[${JOB_NAME}] skipped — ${result.reason}: ${result.message || ''}`);
      return result;
    }
    if (result.success === false) {
      throw new Error(result.error || 'postDiscordCards returned success=false');
    }
    const mode = dryRun ? 'dry-run' : 'sent';
    console.log(`[${JOB_NAME}] ${mode} — games:${result.totalGames} chunks:${result.chunks} cards:${result.totalCards} play:${result.sectionCounts?.official} lean:${result.sectionCounts?.lean} pass:${result.sectionCounts?.passBlocked}`);
    return result;
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
