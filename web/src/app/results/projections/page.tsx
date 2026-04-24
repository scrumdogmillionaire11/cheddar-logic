import type { Metadata } from 'next';
import { ProjectionAccuracyClient } from '@/components/results/ProjectionAccuracyClient';

export const metadata: Metadata = {
  title: 'Projection Results | Cheddar',
  description:
    'Desktop-readable projection settlement and accuracy for active Cheddar model families.',
  openGraph: {
    title: 'Projection Results | Cheddar',
    description:
      'Desktop-readable projection settlement and accuracy for active Cheddar model families.',
    url: 'https://cheddarlogic.com/results/projections',
  },
};

export default function ProjectionAccuracyPage() {
  return <ProjectionAccuracyClient />;
}
