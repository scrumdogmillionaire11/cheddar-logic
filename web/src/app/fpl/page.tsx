import { closeDatabaseReadOnly } from '@cheddar-logic/data';
import FPLProductShell from '@/components/fpl-product-shell';
import FPLPageClient from '@/components/fpl-page-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Feature flag: NEXT_PUBLIC_FPL_PRODUCT_SHELL=true enables the new multi-tab
// product shell (Profile, Build Lab, Squad Audit, Compare, Weekly).
// Set in .env.local for dev; omit or set to false to keep the classic view.
const FPL_PRODUCT_SHELL = process.env.NEXT_PUBLIC_FPL_PRODUCT_SHELL === 'true';

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

    return FPL_PRODUCT_SHELL ? <FPLProductShell /> : <FPLPageClient />;
  } finally {
    try {
      closeDatabaseReadOnly();
    } catch (error) {
      console.warn('[fpl] closeDatabaseReadOnly failed during page teardown', error);
    }
  }
}
