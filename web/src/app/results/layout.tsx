import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Betting Results | Cheddar',
  description:
    'Historical betting results and decision-tier performance for Cheddar signals.',
  openGraph: {
    title: 'Betting Results | Cheddar',
    description:
      'Historical betting results and decision-tier performance for Cheddar signals.',
    url: 'https://cheddarlogic.com/results',
  },
};

export default function ResultsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return <>{children}</>;
}
