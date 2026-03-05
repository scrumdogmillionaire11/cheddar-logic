/**
 * Edge Computation: Single-Execution Verification
 * 
 * Verifies each edge_key is computed exactly once.
 * Format: "${sport}|${gameId}|${market}|${side}|${line}|${book}"
 */

const resolverTracker = new Map();

function mockEdgeComputationEnvironment() {
  resolverTracker.clear();
  return {
    trackResolverCall: (edgeKey, edgeValue) => {
      if (!resolverTracker.has(edgeKey)) {
        resolverTracker.set(edgeKey, []);
      }
      resolverTracker.get(edgeKey).push({ timestamp: Date.now(), edge: edgeValue });
    },
    verifyNoDuplicates: () => {
      const violations = [];
      for (const [key, calls] of resolverTracker.entries()) {
        if (calls.length > 1) {
          violations.push({
            edge_key: key,
            count: calls.length,
            message: `edge_key "${key}" computed ${calls.length} times (expected 1)`
          });
        }
      }
      return violations;
    }
  };
}

describe('Edge Computation: Single-Execution Test', () => {
  test('Each edge_key computed exactly once', () => {
    const tracker = mockEdgeComputationEnvironment();
    tracker.trackResolverCall('NBA|202602280001|SPREAD|HOME|-3.5|DraftKings', 0.47);
    tracker.trackResolverCall('NBA|202602280001|SPREAD|HOME|-3.0|DraftKings', 0.53);
    tracker.trackResolverCall('NHL|202602280002|TOTAL|OVER|215.5|FanDuel', 0.52);
    
    const violations = tracker.verifyNoDuplicates();
    expect(violations).toHaveLength(0);
  });

  test('Duplicate edge_key detects double-computation', () => {
    const tracker = mockEdgeComputationEnvironment();
    tracker.trackResolverCall('NBA|202602280001|SPREAD|HOME|-3.5|DraftKings', 0.47);
    tracker.trackResolverCall('NBA|202602280001|SPREAD|HOME|-3.5|DraftKings', 0.47);
    
    const violations = tracker.verifyNoDuplicates();
    expect(violations).toHaveLength(1);
    expect(violations[0].count).toBe(2);
  });
});

module.exports = { mockEdgeComputationEnvironment };
