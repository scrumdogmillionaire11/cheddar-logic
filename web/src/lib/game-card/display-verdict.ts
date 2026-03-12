/**
 * Display verdict mapping: canonical internal decision statuses to user-facing labels
 * 
 * Internal canonical statuses (never change):
 * - PLAY: Best bet recommendation
 * - LEAN: Mild edge / slight advantage detected
 * - PASS: No actionable edge at current market prices
 * 
 * User-facing labels (localization/UI layer):
 * - PLAY -> "PLAY" + "Fresh Cheddar"
 * - LEAN -> "SLIGHT EDGE" + "Mild Cheddar"
 * - PASS -> "PASS" + "Cottage Cheese"
 * 
 * This single mapping prevents copy drift and ensures consistency across all verdict displays.
 */

export const DISPLAY_VERDICT = {
  PLAY: {
    label: 'PLAY',
    brand: 'Fresh Cheddar',
  },
  LEAN: {
    label: 'SLIGHT EDGE',
    brand: 'Mild Cheddar',
  },
  PASS: {
    label: 'PASS',
    brand: 'Cottage Cheese',
  },
} as const;

export type CanonicalStatus = keyof typeof DISPLAY_VERDICT;

/**
 * Get user-friendly verdict display (label + brand) from canonical decision status
 * @param status - Canonical decision status (PLAY | LEAN | PASS)
 * @returns Display label and brand sublabel, or null if status is invalid
 */
export function getDisplayVerdict(
  status: CanonicalStatus | string | undefined | null,
): (typeof DISPLAY_VERDICT)[CanonicalStatus] | null {
  if (!status || !(status in DISPLAY_VERDICT)) {
    return null;
  }
  return DISPLAY_VERDICT[status as CanonicalStatus];
}
