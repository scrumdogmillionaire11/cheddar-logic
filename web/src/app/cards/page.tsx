import type { Metadata } from 'next';
import { closeDatabaseReadOnly } from '@cheddar-logic/data';
import CardsPageClient from '@/components/cards-page-client';

export const runtime = 'nodejs';

export const metadata: Metadata = {
  title: 'Cards | Cheddar Logic',
  description:
    'Live analytical cards ranked by signal confidence across MLB, NBA, and NHL.',
  openGraph: {
    title: 'Cards | Cheddar Logic',
    description:
      'Live analytical cards ranked by signal confidence across MLB, NBA, and NHL.',
    url: 'https://cheddarlogic.com/cards',
  },
};
export const dynamic = 'force-dynamic';

export default async function CardsPage() {
  try {
    // AUTH DISABLED: Commenting out auth walls to allow public access
    // const auth = getAccessTokenAuthResult(accessToken, RESOURCE.CHEDDAR_BOARD);
    // if (!auth.isAuthenticated) {
    //   redirect('/login?next=/cards');
    // }
    // if (!auth.isEntitled) {
    //   redirect('/subscribe?next=/cards');
    // }

    return <CardsPageClient />;
  } finally {
    try {
      closeDatabaseReadOnly();
    } catch (error) {
      console.warn('[cards] closeDatabaseReadOnly failed during page teardown', error);
    }
  }
}
