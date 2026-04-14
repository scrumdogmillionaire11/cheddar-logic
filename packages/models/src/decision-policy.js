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

function deriveWebhookBucket(payload, context = {}) {
  const isNhlTotal = context?.isNhlTotal === true;
  const is1P = context?.is1P === true;

  let bucket;
  if (isNhlTotal && payload?.nhl_totals_status && typeof payload.nhl_totals_status === 'object') {
    const status = toUpperToken(payload.nhl_totals_status.status);
    bucket =
      status === 'PLAY'
        ? 'official'
        : status === 'SLIGHT EDGE'
          ? 'lean'
          : 'pass_blocked';
  } else if (is1P && payload?.nhl_1p_decision && typeof payload.nhl_1p_decision === 'object') {
    const status = toUpperToken(payload.nhl_1p_decision.surfaced_status);
    bucket =
      status === 'PLAY'
        ? 'official'
        : status.includes('SLIGHT') || status === 'LEAN'
          ? 'lean'
          : 'pass_blocked';
  } else {
    const officialStatus = normalizeOfficialStatus(payload?.decision_v2?.official_status);
    const rootAction = toUpperToken(
      payload?.action || payload?.play?.action || payload?.status,
    );
    const rootClass = toUpperToken(
      payload?.classification || payload?.play?.classification,
    );

    if (officialStatus === 'PLAY' || rootAction === 'FIRE' || rootClass === 'BASE') {
      bucket = 'official';
    } else if (
      officialStatus === 'LEAN' ||
      ['HOLD', 'WATCH', 'LEAN', 'EVIDENCE'].includes(rootAction) ||
      rootClass === 'LEAN'
    ) {
      bucket = 'lean';
    } else {
      bucket = 'pass_blocked';
    }
  }

  const forcePassAction = toUpperToken(payload?.action || payload?.play?.action);
  const forcePassClass = toUpperToken(payload?.classification || payload?.play?.classification);
  if (forcePassAction === 'PASS' || forcePassClass === 'PASS') {
    return 'pass_blocked';
  }

  return bucket;
}

function deriveWebhookReasonCode(payload, bucket) {
  if (bucket !== 'pass_blocked') return null;

  return (
    payload?.pass_reason_code ||
    (Array.isArray(payload?.nhl_totals_status?.reasonCodes)
      ? payload.nhl_totals_status.reasonCodes[0]
      : null) ||
    payload?.nhl_1p_decision?.surfaced_reason_code ||
    'PASS_NO_EDGE'
  );
}

module.exports = {
  deriveWebhookBucket,
  deriveWebhookReasonCode,
  normalizeOfficialStatus,
  normalizeOfficialStatusFromPayload,
  isOfficialStatusActionable,
  rankOfficialStatus,
};