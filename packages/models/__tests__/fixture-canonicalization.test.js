const crypto = require('crypto');

const SET_LIKE_ARRAYS = new Set(['tags', 'labels', 'alternatives']);
const SEQUENCE_ARRAYS = new Set(['driver_inputs', 'chain', 'weights']);

function canonicalizeValue(value, parentKey = null) {
  if (value === null || value === undefined) return value;

  if (Array.isArray(value)) {
    if (SET_LIKE_ARRAYS.has(parentKey)) {
      return value.map(item => canonicalizeValue(item, parentKey)).sort();
    } else if (SEQUENCE_ARRAYS.has(parentKey)) {
      return value.map(item => canonicalizeValue(item, parentKey));
    } else {
      return value.map(item => canonicalizeValue(item, parentKey));
    }
  }

  if (typeof value === 'object' && value !== null) {
    const result = {};
    for (const [key, val] of Object.entries(value).sort()) {
      result[key] = canonicalizeValue(val, key);
    }
    return result;
  }

  return value;
}

function canonicalizeCard(card) {
  const { created_at, expires_at, id, ...stable } = card;
  return canonicalizeValue(stable);
}

function hashCard(card) {
  const canonical = canonicalizeCard(card);
  const json = JSON.stringify(canonical);
  return crypto.createHash('sha256').update(json).digest('hex');
}

describe('Fixture Canonicalization', () => {
  test('Set-like arrays are sorted', () => {
    const card = { tags: ['fast', 'profitable', 'risky'] };
    const canonical = canonicalizeCard(card);
    expect(canonical.tags).toEqual(['fast', 'profitable', 'risky'].sort());
  });

  test('Sequence arrays preserve order', () => {
    const card = {
      driver_inputs: [
        { key: 'rest', value: 1 },
        { key: 'pace', value: 2 }
      ]
    };
    const canonical = canonicalizeCard(card);
    expect(canonical.driver_inputs[0].key).toBe('rest');
    expect(canonical.driver_inputs[1].key).toBe('pace');
  });

  test('Unstable fields excluded', () => {
    const card1 = { edge: 0.47, created_at: '2026-03-04T10:00:00Z', id: 'abc123' };
    const card2 = { edge: 0.47, created_at: '2026-03-04T10:00:01Z', id: 'xyz789' };
    expect(hashCard(card1)).toBe(hashCard(card2));
  });
});

module.exports = { canonicalizeCard, hashCard };
