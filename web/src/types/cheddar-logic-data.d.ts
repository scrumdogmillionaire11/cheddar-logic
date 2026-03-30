// eslint-disable-next-line @typescript-eslint/no-explicit-any
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

  // Default export (CJS interop via esModuleInterop)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const _default: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export default _default;
}
