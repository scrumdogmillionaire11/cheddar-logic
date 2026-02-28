import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { RESOURCE, closeDatabase, initDb } from '@cheddar-logic/data';
import FPLPageClient from '@/components/fpl-page-client';
import { AuthRefresher } from '@/components/auth-refresher';
import { ACCESS_COOKIE_NAME, getAccessTokenAuthResult } from '@/lib/auth/server';

export const runtime = 'nodejs';

export default async function FPLPage() {
  await initDb();
  const cookieStore = await cookies();
  const accessToken = cookieStore.get(ACCESS_COOKIE_NAME)?.value;
  try {
    const auth = getAccessTokenAuthResult(accessToken, RESOURCE.FPL_SAGE);

    if (!auth.isAuthenticated) {
      redirect('/login?next=/fpl');
    }

    if (!auth.isEntitled) {
      redirect('/subscribe?next=/fpl');
    }

    return (
      <>
        <AuthRefresher />
        <FPLPageClient />
      </>
    );
  } finally {
    closeDatabase();
  }
}
