declare module '@cheddar-logic/models' {
  export function computeSogProjection(
    input: Record<string, unknown>,
    overrides?: Record<string, unknown>,
  ): Record<string, unknown>;
}

declare module '@cheddar-logic/models/decision-authority' {
  export type LifecycleEntry = {
    stage: string;
    status: string;
    reason_code: string;
  };

  export type CanonicalDecisionResult = {
    official_status: string;
    is_actionable: boolean;
    reason_code: string;
    source: string;
    lifecycle: LifecycleEntry[];
  };

  export function resolveCanonicalDecision(
    payload: object | null,
    options?: {
      stage?: 'parser' | 'model' | 'publisher' | 'watchdog' | 'read_api';
      fallbackToLegacy?: boolean;
      strictSource?: boolean;
      missingReasonCode?: string;
    },
  ): CanonicalDecisionResult | null;
}
