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
}
