import { closeDatabase, initDb } from '@cheddar-logic/data';
import FPLPageClient from '@/components/fpl-page-client';

export const runtime = 'nodejs';

export default async function FPLPage() {
  await initDb();
  try {
    // AUTH DISABLED: Commenting out auth walls to allow public access
    // const auth = getAccessTokenAuthResult(accessToken, RESOURCE.FPL_SAGE);
    // if (!auth.isAuthenticated) {
    //   redirect('/login?next=/fpl');
    // }
    // if (!auth.isEntitled) {
    //   redirect('/subscribe?next=/fpl');
    // }

    return <FPLPageClient />;
  } finally {
    closeDatabase();
  }
}
