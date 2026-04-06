/**
 * Admin layout — dev-only guard (secondary layer after middleware).
 *
 * Calls notFound() unless BOTH NODE_ENV=development AND MODEL_HEALTH_ENABLED=true.
 * MODEL_HEALTH_ENABLED is set only in .env.local — never in .env.production.
 *
 * This is a belt-and-suspenders check: middleware (proxy.ts) is the primary gate.
 * If middleware is somehow bypassed, this layout prevents rendering.
 */

import { notFound } from 'next/navigation';

export default function AdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const modelHealthEnabled =
    process.env.NODE_ENV === 'development' &&
    process.env.MODEL_HEALTH_ENABLED === 'true';

  if (!modelHealthEnabled) {
    notFound();
  }

  return <>{children}</>;
}
