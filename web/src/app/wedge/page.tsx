import type { Metadata } from 'next';
import { closeDatabaseReadOnly } from '@cheddar-logic/data';
import CardsPageClient from '@/components/cards-page-client';

export const runtime = 'nodejs';

export const metadata: Metadata = {
  title: 'The Wedge | Cheddar Logic',
  description:
    'Live analytical cards ranked by signal confidence across MLB, NBA, and NHL.',
  openGraph: {
    title: 'The Wedge | Cheddar Logic',
    description:
      'Live analytical cards ranked by signal confidence across MLB, NBA, and NHL.',
    url: 'https://cheddarlogic.com/wedge',
  },
};
export const dynamic = 'force-dynamic';

export default async function WedgePage() {
  try {
    // AUTH DISABLED: Commenting out auth walls to allow public access
    // const auth = getAccessTokenAuthResult(accessToken, RESOURCE.CHEDDAR_BOARD);
    // if (!auth.isAuthenticated) {
    //   redirect('/login?next=/wedge');
    // }
    // if (!auth.isEntitled) {
    //   redirect('/subscribe?next=/wedge');
    // }

    return <CardsPageClient />;
  } finally {
    try {
      closeDatabaseReadOnly();
    } catch (error) {
      console.warn('[wedge] closeDatabaseReadOnly failed during page teardown', error);
    }
  }
}