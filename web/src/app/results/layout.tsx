import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Results | Cheddar Logic',
  description:
    'Historical pick results and model performance for Cheddar Logic signals.',
  openGraph: {
    title: 'Results | Cheddar Logic',
    description:
      'Historical pick results and model performance for Cheddar Logic signals.',
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
