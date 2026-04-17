export const PROJECTION_SURFACE_CARD_TYPES = [
  'nhl-pace-1p',
  'mlb-f5',
  'mlb-f5-ml',
  'mlb-full-game',
  'mlb-full-game-ml',
] as const;

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
