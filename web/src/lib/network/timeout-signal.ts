export type TimeoutSignalHandle = {
  signal?: AbortSignal;
  cleanup: () => void;
};

export function createTimeoutSignal(timeoutMs: number): TimeoutSignalHandle {
  if (
    typeof AbortSignal !== 'undefined' &&
    typeof AbortSignal.timeout === 'function'
  ) {
    return {
      signal: AbortSignal.timeout(timeoutMs),
      cleanup: () => {},
    };
  }

  if (typeof AbortController !== 'undefined') {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    return {
      signal: controller.signal,
      cleanup: () => clearTimeout(timer),
    };
  }

  return {
    signal: undefined,
    cleanup: () => {},
  };
}
