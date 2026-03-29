'use client';

import Link from 'next/link';
import FilterPanel from '@/components/filter-panel';
import { StickyBackButton } from '@/components/sticky-back-button';
import {
  CardsPageProvider,
  useCardsPageActions,
  useCardsPageState,
} from './CardsPageContext';
import CardsHeader from './CardsHeader';
import CardsList from './CardsList';
import CardsModeTabs from './CardsModeTabs';

function CardsPageContent() {
  const { activeFilterCount, effectiveFilters, viewMode } = useCardsPageState();
  const { onFiltersChange, onResetFilters } = useCardsPageActions();

  return (
    <div className="min-h-screen bg-night text-cloud px-6 py-12">
      <StickyBackButton
        fallbackHref="/"
        fallbackLabel="Home"
        showAfterPx={120}
      />

      <div className="max-w-4xl mx-auto">
        <div className="mb-8">
          <Link
            href="/"
            className="hidden text-sm text-cloud/60 hover:text-cloud/80 md:inline-flex"
          >
            ← Back to Home
          </Link>
        </div>

        <CardsHeader />
        <CardsModeTabs />

        <FilterPanel
          filters={effectiveFilters}
          viewMode={viewMode}
          onFiltersChange={onFiltersChange}
          onReset={onResetFilters}
          activeCount={activeFilterCount}
        />

        <CardsList />
      </div>
    </div>
  );
}

export default function CardsPageClient() {
  return (
    <CardsPageProvider>
      <CardsPageContent />
    </CardsPageProvider>
  );
}
