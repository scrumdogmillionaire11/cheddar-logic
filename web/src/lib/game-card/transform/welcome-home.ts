export const WELCOME_HOME_CARD_TYPES = Object.freeze([
  'welcome-home',
  'welcome-home-v2',
]);

export function isWelcomeHomeCardType(cardType?: string | null): boolean {
  if (typeof cardType !== 'string') return false;
  const normalized = cardType.trim().toLowerCase();
  return WELCOME_HOME_CARD_TYPES.includes(normalized);
}
