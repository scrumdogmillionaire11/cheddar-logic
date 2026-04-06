/**
 * Next.js Middleware entry point.
 *
 * Re-exports the proxy function (security headers + dev-only route guard) as
 * the default `middleware` export that Next.js requires.
 *
 * The guard logic lives in proxy.ts. This file must NOT contain logic itself —
 * it is purely the wiring layer so Next.js can locate the handler.
 *
 * WARNING: This file must be named `middleware.ts` (not proxy.ts or anything
 * else) for Next.js to pick it up. Renaming it will silently disable all
 * security headers and the Model Health production firewall.
 */

export { proxy as middleware } from './proxy';

// config must be defined directly in this file — Next.js statically parses it
// at compile time and cannot resolve re-exports.
export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|public).*)'],
};
