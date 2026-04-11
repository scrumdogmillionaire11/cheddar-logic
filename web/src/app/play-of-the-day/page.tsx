import type { Metadata } from 'next';
import { closeDatabaseReadOnly } from '@cheddar-logic/data';
import PlayOfTheDayClient from '@/components/play-of-the-day-client';
import { getPotdResponseData } from '@/lib/potd-server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Play of the Day | Cheddar Logic',
  description:
    'Daily signal-qualified pick with confidence context and stake recommendation.',
  openGraph: {
    title: 'Play of the Day | Cheddar Logic',
    description:
      'Daily signal-qualified pick with confidence context and stake recommendation.',
    url: 'https://cheddarlogic.com/play-of-the-day',
  },
};

export default async function PlayOfTheDayPage() {
  try {
    const initialData = await getPotdResponseData();
    return <PlayOfTheDayClient initialData={initialData} />;
  } finally {
    try {
      closeDatabaseReadOnly();
    } catch (error) {
      console.warn(
        '[play-of-the-day] closeDatabaseReadOnly failed during page teardown',
        error,
      );
    }
  }
}
