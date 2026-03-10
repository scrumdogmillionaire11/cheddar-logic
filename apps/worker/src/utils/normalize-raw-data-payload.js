function normalizeRawDataPayload(rawData) {
  if (!rawData) return {};
  if (typeof rawData === 'string') {
    try {
      return JSON.parse(rawData);
    } catch {
      return {};
    }
  }
  return rawData;
}

module.exports = { normalizeRawDataPayload };
