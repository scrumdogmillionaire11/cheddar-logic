import { Metadata } from 'next';
import MarketPulseClient from '@/components/market-pulse/MarketPulseClient';

export const metadata: Metadata = {
  title: 'Market Pulse',
  description: 'Real-time odds divergence monitor across major sportsbooks.',
};

export default function MarketPulsePage() {
  return (
    <main className="mx-auto max-w-4xl px-4 py-8">
      <h1 className="mb-6 text-2xl font-semibold tracking-tight">Market Pulse</h1>
      <MarketPulseClient />
    </main>
  );
}
