declare module '@cheddar-logic/data' {
  // Database helpers
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export function getDatabaseReadOnly(): any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export function closeReadOnlyInstance(db: any): void;
  export function closeDatabaseReadOnly(): void;

  // Results / market helpers
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export function deriveLockedMarketContext(...args: any[]): any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export function formatMarketSelectionLabel(...args: any[]): any;

  // Odds ingest
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export function getOddsIngestFailureSummary(...args: any[]): any;

  // Team metrics
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export function getTeamMetricsWithGames(...args: any[]): any;

  // model_outputs read surface (WI-0760)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export function getModelOutputsBySport(sport: string, sinceUtc: string): any[];

  // pipeline_health read surface (WI-0761)
  export interface PipelineHealthRow {
    id: number;
    phase: string;
    check_name: string;
    status: string;
    reason: string | null;
    created_at: string;
  }
  export function getPipelineHealth(limit?: number): PipelineHealthRow[];

  // Default export (CJS interop via esModuleInterop)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const _default: any;
  export default _default;

  // projection-accuracy data layer (WI-0864/0867)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export function getProjectionAccuracySummary(db: any, opts?: {
    cardFamily?: string;
    gameDateGte?: string;
    gameDateLte?: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  }): any;
}
