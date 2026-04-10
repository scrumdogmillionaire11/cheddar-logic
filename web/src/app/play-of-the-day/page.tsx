import { closeDatabaseReadOnly } from '@cheddar-logic/data';
import PlayOfTheDayClient from '@/components/play-of-the-day-client';
import { getPotdResponseData } from '@/app/api/potd/route';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

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
