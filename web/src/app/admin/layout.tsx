/**
 * Admin layout — dev-only guard (secondary layer after middleware).
 *
 * Calls notFound() for any request that isn't running under NODE_ENV=development.
 * middleware.ts (proxy.ts) is the primary gate — this is belt-and-suspenders.
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
