import { closeDatabase, initDb } from '@cheddar-logic/data';
import CardsPageClient from '@/components/cards-page-client';
import { AuthRefresher } from '@/components/auth-refresher';

export const runtime = 'nodejs';

export default async function CardsPage() {
  await initDb();
  try {
    // AUTH DISABLED: Commenting out auth walls to allow public access
    // const auth = getAccessTokenAuthResult(accessToken, RESOURCE.CHEDDAR_BOARD);
    // if (!auth.isAuthenticated) {
    //   redirect('/login?next=/cards');
    // }
    // if (!auth.isEntitled) {
    //   redirect('/subscribe?next=/cards');
    // }

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
