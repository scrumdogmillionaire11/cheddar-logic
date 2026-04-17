import type { Metadata } from 'next';
import { closeDatabaseReadOnly } from '@cheddar-logic/data';
import FPLPageClient from '@/components/fpl-page-client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'FPL Analytics | Cheddar Logic',
  description:
    'Fantasy Premier League player projections and signal-qualified differentials.',
  openGraph: {
    title: 'FPL Analytics | Cheddar Logic',
    description:
      'Fantasy Premier League player projections and signal-qualified differentials.',
    url: 'https://cheddarlogic.com/fpl',
  },
};

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

    // Single-surface contract: /fpl always renders the weekly analysis surface.
    // FPL_V2_FEATURES remains a server-side toggle for optional sections.
    const v2FeaturesEnabled = process.env.FPL_V2_FEATURES === 'true';

    return <FPLPageClient v2FeaturesEnabled={v2FeaturesEnabled} />;
  } finally {
    try {
      closeDatabaseReadOnly();
    } catch (error) {
      console.warn('[fpl] closeDatabaseReadOnly failed during page teardown', error);
    }
  }
}
