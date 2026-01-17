export type AnalyticsStatusState = "online" | "paused";

export type AnalyticsStatus = {
  state: AnalyticsStatusState;
  lastUpdated: string;
};

const DEFAULT_LAST_UPDATED = "2026-01-01T00:00:00.000Z";

export function getAnalyticsStatus(): AnalyticsStatus {
  const state = process.env.NEXT_PUBLIC_ANALYTICS_STATUS === "paused"
    ? "paused"
    : "online";

  const lastUpdated =
    process.env.NEXT_PUBLIC_ANALYTICS_LAST_UPDATED ?? DEFAULT_LAST_UPDATED;

  return {
    state,
    lastUpdated,
  };
}
