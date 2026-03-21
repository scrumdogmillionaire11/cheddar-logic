export const STALE_ASSET_RELOAD_GUARD_KEY = 'next_static_asset_reload_once';
export const STALE_ASSET_ERROR_MESSAGE_BASE =
  'App assets are out of date. Hard refresh required.';

export function extractNextStaticAssetPath(message: string): string | null {
  const match = message.match(/\/_next\/static\/[^"'\s)]+/);
  return match ? match[0] : null;
}

export function isStaleNextStaticAssetFailure(message: string): boolean {
  if (!message) return false;

  const normalized = message.toLowerCase();
  const hasStaticPath = normalized.includes('/_next/static/');
  const hasCssPath = normalized.includes('.css');
  const hasJsPath = normalized.includes('.js');
  const hasLoadFailureToken =
    normalized.includes('404') ||
    normalized.includes('net::err') ||
    normalized.includes('failed to load');

  const cssOrJsStaticFailure =
    hasStaticPath && (hasCssPath || hasJsPath) && hasLoadFailureToken;

  return (
    normalized.includes('chunkloaderror') ||
    normalized.includes('loading chunk') ||
    normalized.includes('failed to fetch dynamically imported module') ||
    cssOrJsStaticFailure
  );
}

export function stringifyUnknownError(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

function getAssetUrlFromTarget(target: EventTarget | null): string | null {
  if (typeof HTMLScriptElement !== 'undefined' && target instanceof HTMLScriptElement) {
    return target.src || null;
  }
  if (typeof HTMLLinkElement !== 'undefined' && target instanceof HTMLLinkElement) {
    return target.href || null;
  }
  return null;
}

export function buildStaleAssetErrorMessage(event: ErrorEvent): string {
  const parts = [event.message, stringifyUnknownError(event.error)];
  const assetUrl = getAssetUrlFromTarget(event.target);
  if (assetUrl) parts.push(assetUrl);
  return parts.filter(Boolean).join(' | ');
}

export function formatStaleAssetUserMessage(message: string): string {
  const assetPath = extractNextStaticAssetPath(message);
  if (!assetPath) return STALE_ASSET_ERROR_MESSAGE_BASE;
  return `App assets are out of date (${assetPath}). Hard refresh required.`;
}
