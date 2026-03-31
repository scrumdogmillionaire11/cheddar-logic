import { closeDatabaseReadOnly } from '@cheddar-logic/data';
import dynamicImport from 'next/dynamic';
import FPLPageClient from '@/components/fpl-page-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Feature flag: FPL_PRODUCT_SHELL=true enables the new multi-tab product shell
// (Profile, Build Lab, Squad Audit, Compare, Weekly).
// Server-side only (no NEXT_PUBLIC_ prefix) so it is never baked into the
// production bundle — it is evaluated at request time on the server.
// Set in .env.local for dev; do NOT set in production until the shell is ready.
const FPL_PRODUCT_SHELL = process.env.FPL_PRODUCT_SHELL === 'true';

const FPLProductShell = FPL_PRODUCT_SHELL
  ? dynamicImport(() => import('@/components/fpl-product-shell'))
  : null;

export default async function FPLPage() {
  try {
    // AUTH DISABLED: Commenting out auth walls to allow public access
    // const auth = getAccessTokenAuthResult(accessToken, RESOURCE.FPL_SAGE);
    // if (!auth.isAuthenticated) {
    //   redirect('/login?next=/fpl');
    // }
    // if (!auth.isEntitled) {
    //   redirect('/subscribe?next=/fpl');
    // }

    return FPLProductShell ? <FPLProductShell /> : <FPLPageClient />;
  } finally {
    try {
      closeDatabaseReadOnly();
    } catch (error) {
      console.warn('[fpl] closeDatabaseReadOnly failed during page teardown', error);
    }
  }
}
