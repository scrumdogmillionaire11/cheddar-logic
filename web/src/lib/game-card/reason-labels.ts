import cheddarData from '@cheddar-logic/data';

const { REASON_CODE_LABELS: _LABELS, getReasonCodeLabel: _getLabel } = cheddarData as {
  REASON_CODE_LABELS: Record<string, string>;
  getReasonCodeLabel: (code: string | null | undefined) => string | null;
};

export const REASON_CODE_LABELS: Record<string, string> = _LABELS;

export function getReasonCodeLabel(code?: string | null): string | null {
  return _getLabel(code ?? null);
}
