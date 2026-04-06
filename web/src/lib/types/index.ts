// web/src/lib/types/index.ts
// Barrel: canonical home for all runtime types in web/
// Add new runtime type files here as additional `export *` lines.
//
// CONFLICT RESOLUTION:
// Both source files export `Sport` and `PassReasonCode` with different member
// sets. TypeScript TS2308 requires explicit resolution:
//   - Sport: game-card wins (wider: NHL|NBA|NCAAM|SOCCER|MLB|NFL|UNKNOWN)
//   - PassReasonCode: canonical-play wins (used by decision-logic.ts with
//     canonical values like NO_EDGE, TOTAL_BIAS_CONFLICT, etc.)

export * from './game-card';
export * from './canonical-play';
// Explicit overrides to resolve TS2308 ambiguity:
export type { Sport } from './game-card';
export type { PassReasonCode } from './canonical-play';
