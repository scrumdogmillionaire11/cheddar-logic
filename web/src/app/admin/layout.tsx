/**
 * Admin layout — dev-only guard (secondary layer after middleware).
 *
 * Calls notFound() for any request that isn't running under NODE_ENV=development.
 * src/middleware.ts is the primary gate — this is belt-and-suspenders.
 *
 * NOTE: The primary gate only works if the middleware file is named middleware.ts
 * and exports a function named `middleware`. A proxy.ts with any other export
 * name is silently ignored by Next.js (discovered: April 2026).
 */

import { notFound } from 'next/navigation';

export default function AdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  if (process.env.NODE_ENV !== 'development') {
    notFound();
  }

  return <>{children}</>;
}
