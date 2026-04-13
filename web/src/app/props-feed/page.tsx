import type { Metadata } from 'next';
import PropsFeedClient from '@/components/props-feed-client';

export const runtime = 'nodejs';

export const metadata: Metadata = {
  title: 'Props Feed | Cheddar Logic',
  description: 'NHL shots, NHL blocked shots, and MLB pitcher strikeout logs.',
};

export const dynamic = 'force-dynamic';

export default function PropsFeedPage() {
  return <PropsFeedClient />;
}
