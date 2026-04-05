/**
 * Admin layout — dev-only guard.
 *
 * Calls notFound() for any request that isn't running under NODE_ENV=development
 * so the entire /admin subtree (page + API routes) is invisible in production.
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
