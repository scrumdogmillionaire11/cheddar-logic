'use strict';

require('dotenv').config();
const { v4: uuidV4 } = require('uuid');
const { DateTime } = require('luxon');

const {
  insertJobRun,
  markJobRunSuccess,
  markJobRunFailure,
  shouldRunJobKey,
  withDb,
  getDatabase,
  createJob,
} = require('@cheddar-logic/data');
const {
  isWebhookLeanEligible,
  collectReasonCodes,
  collectStructuredReasons,
  describeWebhookReason,
  deriveWebhookWatchState,
  deriveWebhookWouldBecomePlay,
  deriveWebhookDropToPass,
  describeEdgeMagnitude,
} = require('@cheddar-logic/models');
const { getReasonCodeLabel } = require('@cheddar-logic/data');

const JOB_NAME = 'post_discord_cards';
const DEFAULT_CHAR_LIMIT = 1800;
const DISCORD_HARD_LIMIT = 2000;
const DEFAULT_MAX_ROWS = 300;
const WATCH_RECHECK_LEAD_MINUTES = Number(process.env.DISCORD_WATCH_RECHECK_LEAD_MINUTES || 30);
// Leans with |edge| below this are suppressed — rounding error, not signal
// Override with env DISCORD_MIN_LEAN_EDGE (e.g. '0.2')
const MIN_LEAN_EDGE_ABS = Number(process.env.DISCORD_MIN_LEAN_EDGE ?? 0.15);

// Market tags known to the filter system — unknown tokens emit a warning
const KNOWN_MARKET_TAGS = Object.freeze([
  'TOTAL', 'ML', 'Spread', '1P', 'TEAM TOTAL', 'TSOA', 'ANYTIME', 'SOT',
  'SHOTS', 'PROP', 'POTD',
]);

// 429 retry / timeout constants — all module-top, no magic numbers in logic
const DISCORD_RETRY_MAX_AFTER_MS = Number(process.env.DISCORD_MAX_RETRY_AFTER_MS) || 5000;
const DISCORD_TOTAL_TIMEOUT_MS   = Number(process.env.TOTAL_DISCORD_TIMEOUT_MS)   || 10000;
const RETRY_JITTER_MIN_MS = 50;
const RETRY_JITTER_MAX_MS = 150;
const MAX_RETRIES = 1;

const NHL_TOTAL_CONVICTION_LABELS = {
  STRONG_PLAY: 'Strong Play Edge',
  PLAY_GRADE: 'Play-Grade Edge',
  SLIGHT_EDGE: 'Slight Edge',
  NO_EDGE: 'Slight Edge',
};
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

function normalizeSelectionSide(value) {
  const token = normalizeToken(value);
  if (!token) return '';
  if (token.includes('OVER')) return 'OVER';
  if (token.includes('UNDER')) return 'UNDER';
  if (token === 'HOME' || token === 'AWAY') return token;
  return '';
}

function parseCsvTokens(value, normalizer = normalizeToken) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  const tokens = raw
    .split(',')
    .map((token) => normalizer(token))
    .filter(Boolean);
  return tokens.length > 0 ? new Set(tokens) : null;
}

function normalizeWebhookBucketToken(value) {
  const token = normalizeToken(value);
  if (!token) return '';
  if (['PLAY', 'PLAYS', 'OFFICIAL', 'FIRE', 'BASE'].includes(token)) return 'official';
  if (['LEAN', 'LEANS', 'WATCH', 'WATCHES', 'SLIGHT_EDGE', 'SLIGHT EDGE'].includes(token)) return 'lean';
  if (['PASS', 'PASS_BLOCKED', 'BLOCKED'].includes(token)) return 'pass_blocked';
  return token.toLowerCase();
}

// Prevents [object Object] leaking into Discord output
function safeScalar(val) {
  if (val === null || val === undefined) return null;
  if (typeof val === 'object') return null;
  const str = String(val).trim();
  return str || null;
}

function reasonTokens(card) {
  const payload = card?.payloadData || {};
  return collectReasonCodes(payload).map(normalizeToken).filter(Boolean);
}

function humanReason(card) {
  return describeWebhookReason(card?.payloadData || {}, 'pass_blocked') || 'No edge';
}

function extractEdgeValue(card) {
  const payload = card?.payloadData || {};
  const raw = payload?.edge ?? payload?.edge_pct ?? payload?.edge_over_pp;
  if (raw !== null && raw !== undefined) {
    const val = Number(raw);
    if (Number.isFinite(val)) return val;
  }

  const prediction = String(payload?.prediction || payload?.play?.pick_string || '');
  const edgeMatch = prediction.match(/Edge[:\s]+([+-]?\d+\.?\d*)/i);
  if (!edgeMatch) return null;

  const val = Number(edgeMatch[1]);
  return Number.isFinite(val) ? val : null;
}

function describeLeanStrength(card) {
  const edge = extractEdgeValue(card);
  if (!Number.isFinite(edge)) return null;
  const edgeAbs = Math.abs(edge);
  if (edgeAbs >= 0.5) return 'strong lean';
  if (edgeAbs >= MIN_LEAN_EDGE_ABS) return 'thin lean';
  return null;
}

function isBlockedWatchCard(card) {
  const blockingReason = reasonTokens(card).some((token) =>
    token === 'LINE_NOT_CONFIRMED' ||
    token === 'EDGE_RECHECK_PENDING' ||
    token === 'PRICE_SYNC_PENDING' ||
    token === 'EDGE_NO_LONGER_CONFIRMED' ||
    token === 'STALE_MARKET' ||
    token.includes('BLOCK') ||
    token.includes('GATE') ||
    token.includes('VERIFICATION') ||
    token.includes('GOALIE') ||
    token.includes('LINE_MOVEMENT'),
  );
  if (!blockingReason) return false;

  const payload = card?.payloadData || {};
  const playTier = normalizeToken(payload?.decision_v2?.play_tier || payload?.play_tier || payload?.tier);
  return (
    extractEdgeValue(card) !== null ||
    projectionValue(card) !== null ||
    ['BEST', 'GOOD'].includes(playTier)
  );
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
  // WI-0957: 2025-26 renamed MLB venues
  'oakland athletics': 'ATH',           'athletics': 'ATH',
  'sacramento athletics': 'ATH',        'guaranteed rate field': 'CWS', 'rate field': 'CWS',
  'minute maid park': 'HOU',            'daikin park': 'HOU',
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
  // WI-0957: 2025-26 renamed MLB venues
  'oakland athletics': 'Athletics',   'athletics': 'Athletics',
  'sacramento athletics': 'Athletics',
};

const MLB_TEAM_DISPLAY_BY_CODE = Object.freeze({
  ARI: 'ARI Diamondbacks',
  ATL: 'ATL Braves',
  BAL: 'BAL Orioles',
  BOS: 'BOS Red Sox',
  CHC: 'CHC Cubs',
  CWS: 'CWS White Sox',
  CIN: 'CIN Reds',
  CLE: 'CLE Guardians',
  COL: 'COL Rockies',
  DET: 'DET Tigers',
  HOU: 'HOU Astros',
  KCR: 'KCR Royals',
  LAA: 'LAA Angels',
  LAD: 'LAD Dodgers',
  MIA: 'MIA Marlins',
  MIL: 'MIL Brewers',
  MIN: 'MIN Twins',
  NYM: 'NYM Mets',
  NYY: 'NYY Yankees',
  ATH: 'ATH Athletics',
  PHI: 'PHI Phillies',
  PIT: 'PIT Pirates',
  SDP: 'SDP Padres',
  SFG: 'SFG Giants',
  SEA: 'SEA Mariners',
  STL: 'STL Cardinals',
  TBR: 'TBR Rays',
  TEX: 'TEX Rangers',
  TOR: 'TOR Blue Jays',
  WSN: 'WSN Nationals',
});

const MLB_TEAM_VARIANTS = Object.freeze({
  ARI: ['ari', 'az', 'arizona diamondbacks', 'diamondbacks', 'd-backs', 'dbacks', 'arizona'],
  ATL: ['atl', 'atlanta braves', 'braves', 'atlanta'],
  BAL: ['bal', 'baltimore orioles', 'orioles', 'baltimore'],
  BOS: ['bos', 'boston red sox', 'red sox', 'boston'],
  CHC: ['chc', 'ch', 'chicago cubs', 'cubs'],
  CWS: ['cws', 'chw', 'chwsox', 'chicago white sox', 'white sox', 'chi sox', 'chi white sox'],
  CIN: ['cin', 'cincinnati reds', 'reds', 'cincinnati'],
  CLE: ['cle', 'cl', 'cr', 'cleveland guardians', 'guardians', 'cleveland'],
  COL: ['col', 'colorado rockies', 'rockies', 'colorado'],
  DET: ['det', 'detroit tigers', 'tigers', 'detroit'],
  HOU: ['hou', 'ho', 'houston astros', 'astros', 'houston'],
  KCR: ['kcr', 'kc', 'kansas city royals', 'royals', 'kansas city'],
  LAA: ['laa', 'ana', 'la angels', 'los angeles angels', 'angels'],
  LAD: ['lad', 'la dodgers', 'los angeles dodgers', 'dodgers'],
  MIA: ['mia', 'miami marlins', 'marlins', 'miami'],
  MIL: ['mil', 'ml', 'milwaukee brewers', 'brewers', 'milwaukee'],
  MIN: ['min', 'mn', 'minnesota twins', 'twins', 'minnesota'],
  NYM: ['nym', 'new york mets', 'mets'],
  NYY: ['nyy', 'new york yankees', 'yankees'],
  ATH: ['ath', 'oakland athletics', 'sacramento athletics', 'athletics', "a's"],
  PHI: ['phi', 'philadelphia phillies', 'phillies', 'philadelphia'],
  PIT: ['pit', 'pittsburgh pirates', 'pirates', 'pittsburgh'],
  SDP: ['sdp', 'sd', 'san diego padres', 'padres', 'san diego'],
  SFG: ['sfg', 'sf', 'san francisco giants', 'giants', 'san francisco'],
  SEA: ['sea', 'seattle mariners', 'mariners', 'seattle'],
  STL: ['stl', 'st louis cardinals', 'st. louis cardinals', 'cardinals', 'st louis'],
  TBR: ['tbr', 'tb', 'tampa bay rays', 'rays', 'tampa bay'],
  TEX: ['tex', 'tx', 'texas rangers', 'rangers', 'texas'],
  TOR: ['tor', 'to', 'toronto blue jays', 'blue jays', 'toronto'],
  WSN: ['wsn', 'was', 'wsh', 'washington nationals', 'nationals', 'nats'],
});

const MLB_VARIANT_TO_CODE = Object.freeze(
  Object.entries(MLB_TEAM_VARIANTS).reduce((acc, [code, variants]) => {
    acc[code.toLowerCase()] = code;
    for (const variant of variants) {
      const token = String(variant || '').toLowerCase().trim();
      if (token) acc[token] = code;
    }
    return acc;
  }, {}),
);

function normalizeTeamVariant(name) {
  return String(name || '')
    .toLowerCase()
    .trim()
    .replace(/\./g, '')
    .replace(/\s+/g, ' ');
}

function isMlbSportToken(sport) {
  return normalizeToken(sport) === 'MLB' || normalizeToken(sport) === 'BASEBALL_MLB';
}

function abbreviateMlbTeam(name) {
  const normalized = normalizeTeamVariant(name);
  const code = MLB_VARIANT_TO_CODE[normalized];
  if (!code) return null;
  return MLB_TEAM_DISPLAY_BY_CODE[code] || code;
}

function abbreviateTeam(name, { sport = '' } = {}) {
  if (!name) return '';
  if (isMlbSportToken(sport)) {
    const mlbTeam = abbreviateMlbTeam(name);
    if (mlbTeam) return mlbTeam;
  }

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

function abbreviateMatchup(matchup, sport = '') {
  const parts = String(matchup || '').split(' @ ');
  if (parts.length !== 2) return matchup;
  return `${abbreviateTeam(parts[0], { sport })} @ ${abbreviateTeam(parts[1], { sport })}`;
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
  // EVIDENCE cards (non-1P) are context drivers — bypass the pre-stamped webhook_eligible shortcut
  // so the legacy kind !== 'PLAY' gate applies instead.
  if (normalizeToken(card?.payloadData?.kind) === 'EVIDENCE' && !isFirstPeriodCard(card)) {
    return isDisplayableWebhookCardLegacy(card);
  }
  const eligible = card?.payloadData?.webhook_eligible;
  if (typeof eligible === 'boolean') return eligible;
  return isDisplayableWebhookCardLegacy(card);
}

function isDisplayableWebhookCardLegacy(card) {
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
  // EVIDENCE cards are context drivers — never standalone bet rows.
  // Override any pre-stamped webhook_bucket that may have been set when action=FIRE.
  if (normalizeToken(card?.payloadData?.kind) === 'EVIDENCE' && !isFirstPeriodCard(card)) return 'pass_blocked';
  const bucket = normalizeWebhookBucketToken(card?.payloadData?.webhook_bucket);
  if (bucket === 'official' || bucket === 'lean' || bucket === 'pass_blocked') return bucket;
  return classifyDecisionBucketLegacy(card);
}

function classifyDecisionBucketLegacy(card) {
  const payload = card?.payloadData || {};
  const canonical1PDecision = payload?.nhl_1p_decision;
  if (normalizeMarketTag(card) === '1P' && canonical1PDecision && typeof canonical1PDecision === 'object') {
    const surfacedStatus = normalizeToken(canonical1PDecision?.surfaced_status);
    if (surfacedStatus === 'PLAY') return 'official';
    if (surfacedStatus === 'SLIGHT EDGE') return 'lean';
    if (surfacedStatus === 'PASS') return 'pass_blocked';
  }

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

  // 1P cards can be marked PASS when live 1P price lanes are unavailable,
  // while still carrying a directional model call (e.g. BEST_OVER/LEAN_UNDER).
  // In Discord, surface those as actionable from prediction tier.
  const isOnePeriod = normalizeMarketTag(card) === '1P';
  const hasNoProjectionPass = reasons.some(
    (token) => token.includes('FIRST_PERIOD_NO_PROJECTION') || token.includes('FIRST_PERIOD_PRICE_UNAVAILABLE'),
  );
  const predictionToken = normalizeToken(payload?.prediction || payload?.one_p_model_call);
  const hasDirectionalPrediction =
    predictionToken &&
    !predictionToken.includes('PASS') &&
    (predictionToken.includes('OVER') || predictionToken.includes('UNDER'));
  if (isOnePeriod && hasNoProjectionPass && hasDirectionalPrediction) {
    if (predictionToken.includes('BEST') || predictionToken.includes('PLAY')) return 'official';
    if (predictionToken.includes('LEAN') || predictionToken.includes('WATCH') || predictionToken.includes('HOLD')) return 'lean';
    return 'lean';
  }

  if (hasPass || hasBlocked) return 'pass_blocked';
  if (action === 'FIRE' || classification === 'BASE') return 'official';
  if (['WATCH', 'LEAN', 'HOLD'].includes(action) || classification === 'LEAN') return 'lean';
  return 'lean';
}

function resolveNhlTotalConvictionTierFromEdge(edgeRaw) {
  const edge = Number(edgeRaw);
  if (!Number.isFinite(edge)) return 'NO_EDGE';
  const edgeAbs = Math.abs(edge);
  if (edgeAbs >= 1.5) return 'STRONG_PLAY';
  if (edgeAbs >= 1.0) return 'PLAY_GRADE';
  if (edgeAbs >= 0.5) return 'SLIGHT_EDGE';
  return 'NO_EDGE';
}

function getNhlTotalConvictionTier(card) {
  const payload = card?.payloadData || {};
  const isNhl = normalizeToken(card?.sport) === 'NHL';
  if (!isNhl) return null;
  if (normalizeMarketTag(card) !== 'TOTAL') return null;

  const directTier = normalizeToken(payload?.conviction_tier || payload?.conviction?.tier);
  if (directTier && NHL_TOTAL_CONVICTION_LABELS[directTier]) {
    return directTier;
  }

  const rawEdge = payload?.edge ?? payload?.edge_pct ?? payload?.edge_over_pp;
  return resolveNhlTotalConvictionTierFromEdge(rawEdge);
}

function resolveLeanSectionTitle(cards) {
  return cards.length > 0 ? '🟡 Slight Edge (Lean)' : '🟡 Slight Edge (Lean)';
}

/**
 * Parse filter environment variables once at job start.
 * When allow-list is set, deny-list is ignored (allow takes precedence).
 * Returns { allowedSports, allowedMarkets, allowedBuckets, denyMarkets }
 */
function parseFilters() {
  const allowedMarkets = parseCsvTokens(process.env.DISCORD_CARD_WEBHOOK_MARKETS);
  // Warn on unknown market tokens in allow-list (but do not throw)
  if (allowedMarkets) {
    const knownUpper = new Set(KNOWN_MARKET_TAGS.map((t) => normalizeToken(t)));
    for (const token of allowedMarkets) {
      if (!knownUpper.has(normalizeToken(token))) {
        console.warn(`[post-discord-cards] Unknown market token in allow-list: "${token}" — ignored`);
      }
    }
  }
  // When allow-list is active, deny-list is ignored
  const denyMarkets = allowedMarkets ? null : parseCsvTokens(process.env.DISCORD_CARD_WEBHOOK_MARKETS_DENY);

  const filters = {
    allowedSports: parseCsvTokens(process.env.DISCORD_CARD_WEBHOOK_SPORTS),
    allowedMarkets,
    allowedBuckets: parseCsvTokens(process.env.DISCORD_CARD_WEBHOOK_BUCKETS, normalizeWebhookBucketToken),
    denyMarkets,
  };

  // Emit normalized filter log
  const marketsList = filters.allowedMarkets ? [...filters.allowedMarkets].join(',') : '*';
  const denyList = filters.denyMarkets ? [...filters.denyMarkets].join(',') : 'none';
  console.log(`[post-discord-cards] Normalized filters -> markets:[${marketsList}] deny:[${denyList}]`);

  return filters;
}

/**
 * Validate Discord env vars and warn if numeric bounds are violated.
 * Call once at job start.
 */
function validateDiscordEnvVars() {
  const charLimit = Number(process.env.DISCORD_CARD_WEBHOOK_CHAR_LIMIT);
  if (charLimit && (charLimit < 400 || charLimit > 2000)) {
    console.warn(`[post-discord-cards] WARNING: DISCORD_CARD_WEBHOOK_CHAR_LIMIT=${charLimit} is outside allowed range [400, 2000]`);
  }
}

/**
 * Validate a Discord webhook URL: checks https protocol and discord hostname.
 * Warns but does not throw on invalid URL.
 */
function validateDiscordWebhookUrl(url) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:') {
      console.warn(`[post-discord-cards] WARNING: webhook URL does not use https: — ${url}`);
    }
    if (!parsed.hostname.includes('discord')) {
      console.warn(`[post-discord-cards] WARNING: webhook URL hostname does not include 'discord' — ${url}`);
    }
  } catch {
    console.warn(`[post-discord-cards] WARNING: invalid webhook URL — ${url}`);
  }
}

function cardMatchesWebhookFilters(card, bucket, filters) {
  // Resolve filters from env if not provided (backward compat)
  if (!filters) {
    filters = {
      allowedBuckets: parseCsvTokens(process.env.DISCORD_CARD_WEBHOOK_BUCKETS, normalizeWebhookBucketToken),
      allowedSports: parseCsvTokens(process.env.DISCORD_CARD_WEBHOOK_SPORTS),
      allowedMarkets: parseCsvTokens(process.env.DISCORD_CARD_WEBHOOK_MARKETS),
      denyMarkets: null,
    };
  }

  const marketTag = normalizeMarketTag(card);

  // POTD market tag bypasses all filters — always include POTD cards
  if (marketTag === 'POTD') return true;

  const { allowedBuckets, allowedSports, allowedMarkets, denyMarkets } = filters;

  if (allowedBuckets && !allowedBuckets.has(bucket)) return false;
  if (allowedSports && !allowedSports.has(normalizeToken(card?.sport))) return false;

  // Apply deny-list only when allow-list is null (allow-list takes precedence)
  if (allowedMarkets) {
    if (!allowedMarkets.has(normalizeToken(marketTag))) return false;
  } else if (denyMarkets) {
    if (denyMarkets.has(normalizeToken(marketTag))) return false;
  }

  return true;
}

function normalizeMarketTag(card) {
  const payload = card?.payloadData || {};
  const cardType = String(card?.cardType || '').toLowerCase();
  const marketType = String(payload?.market_type || '').toLowerCase();
  const marketKey = String(payload?.market_key || '').toLowerCase();
  const token = `${marketType} ${marketKey} ${cardType}`;

  // POTD must be checked before partial-match rules (e.g. total) to avoid false matches
  if (cardType === 'potd-call' || cardType === 'potd') return 'POTD';

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
  const webhookSide = card?.payloadData?.webhook_display_side;
  if (webhookSide) return webhookSide;
  const canonical1PSide = normalizeSelectionSide(payload?.nhl_1p_decision?.projection?.side);
  if (canonical1PSide) return canonical1PSide;
  const selection = payload?.selection;

  const sideFromPayload =
    normalizeSelectionSide(payload?.market_context?.selection_side) ||
    normalizeSelectionSide(payload?.pricing_trace?.called_side) ||
    normalizeSelectionSide(payload?.market?.selection_side) ||
    normalizeSelectionSide(payload?.driver?.inputs?.selection_side) ||
    normalizeSelectionSide(payload?.selection_type) ||
    normalizeSelectionSide(payload?.recommended_direction) ||
    normalizeSelectionSide(payload?.prediction);

  if (selection && typeof selection === 'object') {
    const derivedSide =
      normalizeSelectionSide(selection.side) ||
      normalizeSelectionSide(selection.direction) ||
      normalizeSelectionSide(selection.selection_side) ||
      normalizeSelectionSide(selection.pick) ||
      sideFromPayload;
    const derived = derivedSide || compactToken(selection.team || selection.player || selection.name || '');
    if (derived) return derived;
  }
  if (selection && typeof selection !== 'object') {
    const sideFromSelection = normalizeSelectionSide(selection);
    if (sideFromSelection) return sideFromSelection;
    // Some legacy 1P payloads store the line in selection (e.g. 1.5).
    // Don't render numeric selection tokens as direction labels.
    if (isFirstPeriodCard(card) && Number.isFinite(Number(selection))) {
      return sideFromPayload;
    }
    return compactToken(selection);
  }

  if (sideFromPayload) return sideFromPayload;

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
  if (value.startsWith('+') || value.startsWith('-')) return value;

  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric > 0) return `+${numeric}`;
  return `${value}`;
}

function decisionReason(card) {
  const payload = card?.payloadData || {};
  const direct = payload?.pass_reason_code || payload?.pass_reason;
  if (direct) return normalizeToken(direct);
  const reasonCode = Array.isArray(payload?.reason_codes) ? payload.reason_codes[0] : null;
  if (reasonCode) return normalizeToken(reasonCode);
  if (payload?.blocked_reason_code) return normalizeToken(payload.blocked_reason_code);
  return null;
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

function resolveWhyLine(card, bucket) {
  const why = summarizeReasoning(card);
  if (why) return why;
  return null;
}

function watchStateLabel(card) {
  return deriveWebhookWatchState(card?.payloadData || {});
}

function watchToPlayLine(card) {
  const payload = card?.payloadData || {};
  const state = watchStateLabel(card);
  return deriveWebhookWouldBecomePlay(payload, state);
}

function watchDropToPassLine(card) {
  const payload = card?.payloadData || {};
  const state = watchStateLabel(card);
  return deriveWebhookDropToPass(payload, state);
}

function watchRecheckDeadlineLine(card) {
  const gameTs = Date.parse(card?.gameTimeUtc || '');
  if (!Number.isFinite(gameTs)) return null;

  const leadMinutes = Number.isFinite(WATCH_RECHECK_LEAD_MINUTES)
    ? Math.max(5, Math.round(WATCH_RECHECK_LEAD_MINUTES))
    : 30;
  const recheckDate = new Date(gameTs - leadMinutes * 60 * 1000);
  return `Recheck by: ${formatEtTime(recheckDate.toISOString())} (T-${leadMinutes}m)`;
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
    const why = resolveWhyLine(card, bucket);

    const proj = projectionValue(card);
    const priced = pickStr
      ? (priceVal ? `${pickStr} (${priceVal})` : pickStr)
      : 'No selection';

    // Second line: projection | edge
    const edgeRawProp = extractEdgeValue(card);
    const edgeProp = edgeRawProp !== null ? formatEdgeValue(edgeRawProp) : null;
    const leanStrength = bucket === 'lean' ? describeLeanStrength(card) : null;
    const propMetricParts = [];
    if (proj) propMetricParts.push(proj);
    if (edgeProp) propMetricParts.push(`Edge: ${edgeProp}${leanStrength ? ` (${leanStrength})` : ''}`);
    const propMetricsLine = propMetricParts.join(' | ');

    const lines = [`PROP | ${priced}`];
    if (propMetricsLine) lines.push(propMetricsLine);
    if (why)     lines.push(`Why: ${why}`);
    const wProp = payload?.price_staleness_warning;
    if (wProp) lines.push(`⚠️ Hard-locked at ${wProp.locked_price} — current may be ${wProp.current_candidate_price} (${wProp.delta_american} pts drift, T-${wProp.minutes_to_start}min)`);
    return lines.join('\n');
  }

  const baseMarket = normalizeMarketTag(card);
  const selection = selectionSummary(card);
  const line      = lineSummary(card);
  const price     = priceSummary(card);
  const market =
    baseMarket === 'ML' && (selection === 'OVER' || selection === 'UNDER') && line
      ? 'TOTAL'
      : baseMarket;

  // 1P cards without a resolved OVER/UNDER direction are unactionable — suppress entirely
  if (market === '1P' && selection !== 'OVER' && selection !== 'UNDER') return null;

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
  const why     = resolveWhyLine(card, bucket);

  // Second line: projection | edge (line is already embedded in the pick string)
  const edgeRaw2 = extractEdgeValue(card);
  const edgeFormatted2 = edgeRaw2 !== null ? formatEdgeValue(edgeRaw2) : null;
  const edgeBand = describeEdgeMagnitude(Math.abs(edgeRaw2));
  const metricParts2 = [];
  if (proj) metricParts2.push(proj);
  if (edgeFormatted2) metricParts2.push(`Edge: ${edgeFormatted2}${edgeBand ? ` (${edgeBand})` : ''}`);
  const metricsLine2 = metricParts2.join(' | ');

  const lines = [`${market} | ${priced}`];
  if (metricsLine2) lines.push(metricsLine2);
  if (bucket === 'blocked_watch') {
    lines.push(`State: ${watchStateLabel(card)}`);
    lines.push(watchToPlayLine(card));
    const recheckByLine = watchRecheckDeadlineLine(card);
    if (recheckByLine) lines.push(recheckByLine);
    lines.push(watchDropToPassLine(card));
    const reason = humanReason(card);
    if (reason && reason !== 'No edge') lines.push(`Why: ${reason}`);
  }
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

// One-line collapsed PASS summary: one primary reason for humans, contextual hints for context.
// Uses structured reasons so human sees clean signal, not machine noise.
function collapsedPassSummary(cards) {
  if (cards.length === 0) return null;

  const primaryLabels = new Set();
  const marketIssues = new Set(); // unique issue types, not occurrence counts
  const dataIssues = new Set();

  for (const card of cards) {
    const s = collectStructuredReasons(card?.payloadData || {});
    if (s.primary_reason) {
      primaryLabels.add(getReasonCodeLabel(s.primary_reason) || 'No edge');
    }
    for (const code of s.market_flags) marketIssues.add(code);
    for (const code of s.data_flags) dataIssues.add(code);
  }

  const primaryLine = [...primaryLabels][0] || 'No playable edges';
  const hints = [];
  if (marketIssues.size > 0) hints.push('market stale');
  if (dataIssues.size > 0) hints.push('data incomplete');
  const hintLine = hints.length > 0 ? `\n_(${hints.join(', ')})_` : '';

  return `⚪ PASS\n${primaryLine}${hintLine}`;
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

const _defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function sendDiscordMessages({
  webhookUrl,
  messages,
  fetchImpl = fetch,
  sleepFn = _defaultSleep,
}) {
  const startEpoch = Date.now();
  let sentCount = 0;

  for (const message of messages) {
    // Check cumulative budget before each send
    if (Date.now() - startEpoch >= DISCORD_TOTAL_TIMEOUT_MS) {
      throw new Error('Discord timeout budget exceeded');
    }

    let retries = 0;
    let sent = false;

    while (!sent) {
      const response = await fetchImpl(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: message }),
      });

      if (response.ok) {
        sentCount++;
        sent = true;
        continue;
      }

      if (response.status === 429) {
        // Already exhausted retries — fail immediately
        if (retries >= MAX_RETRIES) {
          const body = await response.text().catch(() => '');
          throw new Error(`Discord webhook failed (429 — MAX_RETRIES exhausted): ${body}`);
        }

        // Parse retry_after (may be float seconds)
        let retryAfterMs = 0;
        try {
          const body = await response.json().catch(() => ({}));
          const retryAfterSeconds = Number(body?.retry_after ?? 0);
          retryAfterMs = Math.ceil(retryAfterSeconds * 1000);
        } catch {
          retryAfterMs = 0;
        }

        // Fail fast if retry_after exceeds our budget
        if (retryAfterMs > DISCORD_RETRY_MAX_AFTER_MS) {
          throw new Error(`Discord webhook 429: retry_after ${retryAfterMs}ms exceeds max ${DISCORD_RETRY_MAX_AFTER_MS}ms — failing fast`);
        }

        const jitter = RETRY_JITTER_MIN_MS + Math.floor(Math.random() * (RETRY_JITTER_MAX_MS - RETRY_JITTER_MIN_MS + 1));
        const sleepMs = retryAfterMs + jitter;
        console.log(`[post-discord-cards] Rate limited — retrying after ${sleepMs}ms (retry ${retries + 1}/${MAX_RETRIES})`);
        await sleepFn(sleepMs);

        // Check budget again after sleep
        if (Date.now() - startEpoch >= DISCORD_TOTAL_TIMEOUT_MS) {
          throw new Error('Discord timeout budget exceeded');
        }

        retries++;
        continue;
      }

      // Non-429 error — throw immediately
      const body = await response.text().catch(() => '');
      throw new Error(`Discord webhook failed (${response.status}): ${body}`);
    }
  }

  return sentCount;
}

function fetchCardsForSnapshot({ maxRows = DEFAULT_MAX_ROWS, now = new Date(), includePotd = false } = {}) {
  const nowEt = DateTime.fromJSDate(now).setZone('America/New_York');
  const dayStartUtc = nowEt.startOf('day').toUTC().toISO();
  const dayEndUtc = nowEt.plus({ days: 1 }).startOf('day').toUTC().toISO();

  // When includePotd is true, allow potd-call rows only if final_play_state = 'OFFICIAL_PLAY'.
  // This prevents NO_PICK entries from ever appearing in the snapshot.
  const potdFilter = includePotd
    ? `AND (LOWER(cp.card_type) != 'potd-call' OR json_extract(cp.payload_data, '$.final_play_state') = 'OFFICIAL_PLAY')`
    : `AND LOWER(cp.card_type) != 'potd-call'`;

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
          ${potdFilter}
          AND g.game_time_utc IS NOT NULL
          AND datetime(g.game_time_utc) >= datetime(?)
          AND datetime(g.game_time_utc) < datetime(?)
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
    .all(dayStartUtc, dayEndUtc, Math.max(1, Number(maxRows) || DEFAULT_MAX_ROWS));

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
  const eligible = card?.payloadData?.webhook_lean_eligible;
  if (typeof eligible === 'boolean') return eligible;
  const payload = card?.payloadData || {};
  const val = extractEdgeValue(card);
  if (Number.isFinite(val)) {
    return isWebhookLeanEligible(payload, MIN_LEAN_EDGE_ABS);
  }

  return true; // no parseable edge → allow through (don't drop unknowns)
}

function buildDiscordSnapshot({ now = new Date(), cards = [], filters = null, includePotd = false } = {}) {
  // Parse filters once if not provided (backward compat / direct callers)
  const resolvedFilters = filters || parseFilters();
  const preFilterCount = cards.length;

  // Separate POTD cards — they render in a distinct leading section and bypass market filters.
  const potdCards = includePotd ? cards.filter((c) => String(c.cardType || '').toLowerCase() === 'potd-call') : [];
  const regularCards = includePotd ? cards.filter((c) => String(c.cardType || '').toLowerCase() !== 'potd-call') : cards;

  const filtered = prioritizeClearPlays(regularCards.filter(isDisplayableWebhookCard));
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

  // Render POTD leading section — one block per POTD card, before all game entries.
  // POTD rows bypass market filters (cardMatchesWebhookFilters already returns true for POTD).
  for (const potdCard of potdCards) {
    const payload = potdCard.payloadData || {};
    const selLabel = payload.selection_label || selectionSummary(potdCard) || 'Pick TBD';
    const priceStr = payload.price != null ? ` (${payload.price > 0 ? '+' : ''}${payload.price})` : '';
    const edgePct = Number.isFinite(Number(payload.edge_pct)) ? `${(Number(payload.edge_pct) * 100).toFixed(1)}%` : null;
    const scoreStr = Number.isFinite(Number(payload.total_score)) ? Number(payload.total_score).toFixed(3) : null;
    const potdLines = [
      '═════════════════',
      `⭐ PLAY OF THE DAY | ${sportLabel(potdCard.sport)}`,
      potdCard.matchup || potdCard.cardTitle || 'POTD',
      `Game: ${formatEtTime(potdCard.gameTimeUtc)}`,
      `As of: ${snapshotEt}`,
      '',
      `Pick: ${selLabel}${priceStr}`,
    ];
    if (edgePct) potdLines.push(`Edge: ${edgePct}${scoreStr ? ` | Score: ${scoreStr}` : ''}`);
    potdLines.push('═════════════════');
    messages.push({ sport: 'potd', text: potdLines.join('\n') });
    sectionCounts.official += 1;
  }

  for (const gameCards of gameEntries) {
    const seed        = gameCards[0] || {};
    const official    = gameCards.filter(
      (c) => classifyDecisionBucket(c) === 'official' && cardMatchesWebhookFilters(c, 'official', resolvedFilters),
    );
    // Apply LEAN threshold — drop sub-threshold edge leans before rendering
    const leans       = gameCards
      .filter((c) => classifyDecisionBucket(c) === 'lean')
      .filter((c) => cardMatchesWebhookFilters(c, 'lean', resolvedFilters))
      .filter(passesLeanThreshold);
    const passBlocked = gameCards.filter(
      (c) =>
        classifyDecisionBucket(c) === 'pass_blocked' && cardMatchesWebhookFilters(c, 'pass_blocked', resolvedFilters),
    );
    const blockedWatch = passBlocked.filter(isBlockedWatchCard);

    sectionCounts.official    += official.length;
    sectionCounts.lean        += leans.length;
    sectionCounts.passBlocked += passBlocked.length;

    // Hard send filter — skip games with nothing actionable
    if (official.length === 0 && leans.length === 0 && blockedWatch.length === 0) continue;

    const shortMatchup = abbreviateMatchup(seed.matchup || 'Unknown', seed?.sport);
    const startEt      = formatEtTime(seed?.gameTimeUtc);

    const headerLines = [
      '─────────────────',
      `${sportLabel(seed?.sport)} | ${startEt}`,
      shortMatchup,
      `As of: ${snapshotEt}`,
    ];

    const officialLines = sectionLines('🟢 PLAY', official, 'official');
    if (officialLines.length > 0) headerLines.push('', ...officialLines);

    const blockedLines = sectionLines('⚠️ WATCH — not a play yet', blockedWatch, 'blocked_watch');
    if (blockedLines.length > 0) headerLines.push('', ...blockedLines);

    const leanLines = sectionLines(resolveLeanSectionTitle(leans), leans, 'lean');
    if (leanLines.length > 0) headerLines.push('', ...leanLines);

    const hasRenderedContent = officialLines.length > 0 || blockedLines.length > 0 || leanLines.length > 0;
    if (!hasRenderedContent) {
      continue; // no bettor-usable content rendered — skip entirely
    }

    headerLines.push('─────────────────');
    messages.push({ sport: normalizeToken(seed?.sport || ''), text: headerLines.join('\n') });
  }

  if (messages.length === 0 && preFilterCount > 0) {
    console.warn(`[post-discord-cards] WARNING — 0 cards matched filters after processing. Total cards before filter: ${preFilterCount}`);
  }

  const lines = [
    `Cheddar snapshot (${now.toISOString()})`,
    `Games posted: ${messages.length} | Cards: ${filtered.length} | Play: ${sectionCounts.official} | Lean: ${sectionCounts.lean}`,
  ];

  const messageTexts = messages.map((m) => m.text);
  return {
    content: lines.join('\n'),
    messages: messageTexts,
    messagesBySport: messages.reduce((acc, m) => {
      if (!acc[m.sport]) acc[m.sport] = [];
      acc[m.sport].push(m.text);
      return acc;
    }, {}),
    totalCards: filtered.length,
    totalGames: messages.length,
    sectionCounts,
  };
}

// Resolve the webhook URL for a given sport token.
// Checks DISCORD_CARD_WEBHOOK_URL_<SPORT> first, falls back to DISCORD_CARD_WEBHOOK_URL.
function resolveWebhookUrlForSport(sport) {
  const sportKey = normalizeToken(sport);
  const sportSpecific = sportKey
    ? String(process.env[`DISCORD_CARD_WEBHOOK_URL_${sportKey}`] || '').trim()
    : '';
  if (sportSpecific) return sportSpecific;
  return String(process.env.DISCORD_CARD_WEBHOOK_URL || '').trim();
}

async function postDiscordCards({ jobKey = null, dryRun = false, now = new Date() } = {}) {
  const enabled = process.env.ENABLE_DISCORD_CARD_WEBHOOKS === 'true';
  const fallbackUrl = String(process.env.DISCORD_CARD_WEBHOOK_URL || '').trim();
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

  if (!fallbackUrl) {
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

  // Validate env and URL once at job start
  validateDiscordEnvVars();
  validateDiscordWebhookUrl(fallbackUrl);

  // Parse filters once at job start and emit startup log
  const filters = parseFilters();
  const sportsList = filters.allowedSports ? [...filters.allowedSports].join(',') : '*';
  const marketsCount = filters.allowedMarkets ? filters.allowedMarkets.size : '*';
  const bucketsCount = filters.allowedBuckets ? filters.allowedBuckets.size : '*';
  const denyCount = filters.denyMarkets ? filters.denyMarkets.size : 0;
  console.log(`[post-discord-cards] Filters — sports:${sportsList} markets:${marketsCount} buckets:${bucketsCount} deny:${denyCount}`);

  const runId = `job-${JOB_NAME}-${new Date().toISOString().split('.')[0]}-${uuidV4().slice(0, 8)}`;

  return withDb(async () => {
    if (jobKey && !shouldRunJobKey(jobKey)) {
      return { success: true, skipped: true, reason: 'idempotent_skip', jobKey };
    }

    const includePotd = process.env.DISCORD_INCLUDE_POTD_IN_SNAPSHOT === 'true';
    const cards = fetchCardsForSnapshot({ maxRows, now, includePotd });
    const snapshot = buildDiscordSnapshot({ cards, now, filters, includePotd });

    // Group chunks by sport so each sport can route to its own webhook channel.
    // Sports with no dedicated URL fall back to DISCORD_CARD_WEBHOOK_URL.
    const routingPlan = [];
    const routedSports = new Set();
    for (const [sport, sportMessages] of Object.entries(snapshot.messagesBySport)) {
      const url = resolveWebhookUrlForSport(sport);
      if (!url) continue;
      const chunks = sportMessages.flatMap((m) => chunkDiscordContent(m, charLimit));
      if (chunks.length === 0) continue;
      routingPlan.push({ sport, url, chunks });
      routedSports.add(sport);
    }
    // Any messages whose sport had no specific URL have already been routed via fallback above.
    // Collect unrouted messages and route to fallback if there are any sports not yet handled.
    const fallbackMessages = snapshot.messages.filter((_, i) => {
      const sport = Object.keys(snapshot.messagesBySport).find((s) =>
        (snapshot.messagesBySport[s] || []).includes(snapshot.messages[i]),
      );
      return !sport || !routedSports.has(sport) || resolveWebhookUrlForSport(sport) === fallbackUrl;
    });
    // Simplest: if any sport URLs differ from fallback, use messagesBySport routing.
    // Otherwise fall back to the original flat send.
    const hasPerSportRouting = routingPlan.some((r) => r.url !== fallbackUrl);
    const allChunks = hasPerSportRouting
      ? null
      : snapshot.messages.flatMap((message) => chunkDiscordContent(message, charLimit));

    if (dryRun) {
      return {
        success: true,
        dryRun: true,
        chunks: hasPerSportRouting
          ? routingPlan.reduce((s, r) => s + r.chunks.length, 0)
          : allChunks.length,
        totalCards: snapshot.totalCards,
        totalGames: snapshot.totalGames,
        sectionCounts: snapshot.sectionCounts,
      };
    }

    insertJobRun(JOB_NAME, runId, jobKey);
    try {
      let sentCount = 0;
      if (hasPerSportRouting) {
        for (const { sport, url, chunks } of routingPlan) {
          console.log(`[post-discord-cards] Routing ${chunks.length} chunk(s) for ${sport} to dedicated channel`);
          sentCount += await sendDiscordMessages({ webhookUrl: url, messages: chunks });
        }
      } else {
        sentCount = await sendDiscordMessages({ webhookUrl: fallbackUrl, messages: allChunks });
      }
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
  isDisplayableWebhookCardLegacy,
  isPlayerPropCard,
  isFirstPeriodCard,
  buildDiscordSnapshot,
  chunkDiscordContent,
  sendDiscordMessages,
  classifyDecisionBucket,
  classifyDecisionBucketLegacy,
  selectionSummary,
  passesLeanThreshold,
  decisionReason,
  // WI-1039-A: filter hygiene exports
  cardMatchesWebhookFilters,
  normalizeMarketTag,
  parseFilters,
  KNOWN_MARKET_TAGS,
  // WI-1039-B2: snapshot POTD inclusion
  fetchCardsForSnapshot,
  // WI-1039-C: retry/timeout constants
  DISCORD_RETRY_MAX_AFTER_MS,
  DISCORD_TOTAL_TIMEOUT_MS,
  RETRY_JITTER_MIN_MS,
  RETRY_JITTER_MAX_MS,
  MAX_RETRIES,
};
