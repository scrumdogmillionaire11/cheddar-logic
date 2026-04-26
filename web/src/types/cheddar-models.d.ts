declare module '@cheddar-logic/models' {
  export function computeSogProjection(
    input: Record<string, unknown>,
    overrides?: Record<string, unknown>,
  ): Record<string, unknown>;

  export function resolveCanonicalDecision(
    payload: Record<string, unknown> | null,
    options?: {
      stage?: 'parser' | 'model' | 'publisher' | 'watchdog' | 'read_api';
      fallbackToLegacy?: boolean;
      strictSource?: boolean;
      missingReasonCode?: string;
    },
  ): {
    official_status: string;
    is_actionable: boolean;
    tier: string;
    reason_code: string;
    source: string;
    lifecycle: Array<{
      stage: string;
      status: string;
      reason_code: string;
    }>;
  } | null;
}
