function toUpperToken(value) {
  if (value == null) return '';
  return String(value).trim().toUpperCase();
}

function normalizeOfficialStatus(value) {
  const token = toUpperToken(value);
  if (token === 'PLAY' || token === 'LEAN' || token === 'PASS') {
    return token;
  }
  return '';
}

function normalizeOfficialStatusFromPayload(payload) {
  return normalizeOfficialStatus(payload?.decision_v2?.official_status);
}

function isOfficialStatusActionable(value) {
  const status = normalizeOfficialStatus(value);
  return status === 'PLAY' || status === 'LEAN';
}

function rankOfficialStatus(value) {
  const status = normalizeOfficialStatus(value);
  if (status === 'PLAY') return 2;
  if (status === 'LEAN') return 1;
  return 0;
}

module.exports = {
  normalizeOfficialStatus,
  normalizeOfficialStatusFromPayload,
  isOfficialStatusActionable,
  rankOfficialStatus,
};