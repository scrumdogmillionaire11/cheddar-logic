export const PROJECTION_SURFACE_CARD_TYPES = [
  'nhl-pace-1p',
  'nhl-pace-totals',        
  'nhl-totals-call',
  'nab-totals-call',       
  'nba-spread-call',        
  'nhl-moneyline-call',     
  'mlb-f5',
  'mlb-f5-ml',
  'mlb-full-game',
  'mlb-full-game-ml',
  'mlb-pitcher-k',
] as const;

// Cards-read projection-surface allowlist. Purpose: these card types are
// intentionally renderable even when their payload carries projection-only
// markers, so the generic betting-surface payload gate must not hide them.
// Failure semantics: non-allowlisted card types remain subject to
// PROJECTION_ONLY_* / SYNTHETIC_FALLBACK_* drop diagnostics.
const PROJECTION_SURFACE_CARD_TYPE_SET = new Set<string>(
  PROJECTION_SURFACE_CARD_TYPES,
);

export const PROJECTION_SURFACE_CARD_TYPES_SQL = PROJECTION_SURFACE_CARD_TYPES
  .map((cardType) => `'${cardType}'`)
  .join(', ');

export function isProjectionSurfaceCardType(
  cardType: string | null | undefined,
): boolean {
  if (typeof cardType !== 'string') return false;
  const normalized = cardType.trim().toLowerCase();
  return PROJECTION_SURFACE_CARD_TYPE_SET.has(normalized);
}
