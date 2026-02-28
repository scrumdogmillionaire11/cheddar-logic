import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { RESOURCE, closeDatabase, initDb } from '@cheddar-logic/data';
import CardsPageClient from '@/components/cards-page-client';
import { AuthRefresher } from '@/components/auth-refresher';
import { ACCESS_COOKIE_NAME, getAccessTokenAuthResult } from '@/lib/auth/server';

export const runtime = 'nodejs';

export default async function CardsPage() {
  await initDb();
  const cookieStore = await cookies();
  const accessToken = cookieStore.get(ACCESS_COOKIE_NAME)?.value;
  try {
    const auth = getAccessTokenAuthResult(accessToken, RESOURCE.CHEDDAR_BOARD);

    if (!auth.isAuthenticated) {
      redirect('/login?next=/cards');
    }

    if (!auth.isEntitled) {
      redirect('/subscribe?next=/cards');
    }

    return (
      <>
        <AuthRefresher />
        <CardsPageClient />
      </>
    );
  } finally {
    closeDatabase();
  }
}
