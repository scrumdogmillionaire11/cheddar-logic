/**
 * Centralized display and projection tier thresholds.
 * 
 * CRITICAL: This file is for DISPLAY and PROJECTION TIERS only.
 * Official PLAY/LEAN/PASS thresholds remain in decision-pipeline-v2-edge-config.js
 * 
 * Unit separation:
 * - discord bands: decimal fraction (e.g., 0.2 = 20% edge)
 * - nhl_shots bands: shots (e.g., 0.8 SOG)
 */

const EDGE_MAGNITUDE_TIERS = Object.freeze({
  discord: Object.freeze({
    strong_min: 0.2,      // 20% — display as "(strong)"
    thin_min: 0.05,       // 5%  — display as "(thin)"
  }),
  nhl_shots: Object.freeze({
    hot_min: 0.8,         // 0.8 SOG — clear edge
    watch_min: 0.5,       // 0.5 SOG — moderate edge
  }),
});

/**
 * Normalize edge for band classification (handles floating-point precision).
 * Rounds to 4 decimal places to avoid 0.199999... ≠ 0.2 bugs.
 * 
 * @param {number} edgeAbs - Absolute value of edge
 * @returns {number} Normalized edge
 */
function normalizeEdgeForBand(edgeAbs) {
  if (!Number.isFinite(edgeAbs)) return 0;
  return Number(edgeAbs.toFixed(4));
}

/**
 * Classify edge magnitude descriptor for Discord display.
 * 
 * Returns "strong", "thin", or null. Used ONLY for visual labels on cards.
 * Does NOT affect PLAY/LEAN/PASS classification.
 * 
 * @param {number} edgeAbs - Absolute value of edge
 * @returns {string|null} "strong", "thin", or null
 */
function describeEdgeMagnitude(edgeAbs) {
  const normalized = normalizeEdgeForBand(Math.abs(edgeAbs));
  if (normalized >= EDGE_MAGNITUDE_TIERS.discord.strong_min) return 'strong';
  if (normalized >= EDGE_MAGNITUDE_TIERS.discord.thin_min) return 'thin';
  return null;
}

/**
 * Classify NHL SOG edge tier (HOT / WATCH / COLD).
 * 
 * Input: projection-model edge in shots (not probability %).
 * Confidence gate: any edge < 0.5 confidence → COLD (noise filtering).
 * 
 * Unit: This ONLY applies to SOG/projection models. Do NOT use for bet classification.
 * 
 * @param {number} edgeAbs - Absolute value of SOG edge (in shots)
 * @param {number} confidence - Data quality confidence (0-1)
 * @returns {string} "HOT", "WATCH", or "COLD"
 */
function classifyNhlSogTier(edgeAbs, confidence) {
  if (!Number.isFinite(confidence) || confidence < 0.5) return 'COLD';
  const normalized = normalizeEdgeForBand(Math.abs(edgeAbs));
  if (normalized >= EDGE_MAGNITUDE_TIERS.nhl_shots.hot_min) return 'HOT';
  if (normalized >= EDGE_MAGNITUDE_TIERS.nhl_shots.watch_min) return 'WATCH';
  return 'COLD';
}

module.exports = {
  EDGE_MAGNITUDE_TIERS,
  normalizeEdgeForBand,
  describeEdgeMagnitude,
  classifyNhlSogTier,
};
