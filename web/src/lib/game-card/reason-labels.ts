import {
  REASON_CODE_LABELS as CANONICAL_REASON_CODE_LABELS,
  getReasonCodeLabel as canonicalGetReasonCodeLabel,
} from '@cheddar-logic/data';

export const REASON_CODE_LABELS: Record<string, string> =
  CANONICAL_REASON_CODE_LABELS as Record<string, string>;

export function getReasonCodeLabel(code?: string | null): string | null {
  return canonicalGetReasonCodeLabel(code ?? null);
}
