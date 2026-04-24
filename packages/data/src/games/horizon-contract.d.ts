export declare const HORIZON_CONTRACT_VERSION: string;

/**
 * Compute the MLB games visibility horizon end time (ET day boundary).
 * Returns a SQL-compatible UTC timestamp: 'YYYY-MM-DD HH:MM:SS'.
 */
export declare function computeMLBHorizonEndUtc(nowUtc: Date): string;

/**
 * Approximate hours from nowUtc to the horizon end. For diagnostics only.
 */
export declare function horizonEndToApproximateHours(nowUtc: Date): number;
