/**
 * Cards Display Container
 * 
 * Fetches and displays all cards for a game.
 * Handles loading states, filtering, and empty states.
 */

'use client';

import React, { useEffect, useState } from 'react';
import Card, { CardProps } from './card';

interface CardsContainerProps {
  gameId: string;
  sport?: string;
  cardType?: string;
  maxCards?: number;
}

export default function CardsContainer({ 
  gameId, 
  sport,
  cardType,
  maxCards = 10 
}: CardsContainerProps) {
  const [cards, setCards] = useState<CardProps[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const fetchCards = async () => {
      try {
        setLoading(true);
        setError(null);

        // Build query params
        const params = new URLSearchParams();
        if (cardType) params.append('cardType', cardType);

        const url = `/api/cards/${gameId}${params.toString() ? '?' + params.toString() : ''}`;
        const response = await fetch(url);

        if (!response.ok) {
          throw new Error(`Failed to fetch cards: ${response.statusText}`);
        }

        const data = await response.json();

        if (!data.success) {
          throw new Error(data.error || 'Failed to fetch cards');
        }

        // Limit cards if needed
        const limited = data.data.slice(0, maxCards);
        setCards(limited);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Unknown error');
      } finally {
        setLoading(false);
      }
    };

    fetchCards();
  }, [gameId, cardType, maxCards]);

  if (loading) {
    return (
      <div className="space-y-4">
        <div className="h-48 rounded-xl bg-slate-800/50 animate-pulse" />
        <div className="h-48 rounded-xl bg-slate-800/50 animate-pulse" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="rounded-xl border border-red-700 bg-red-900/20 p-4">
        <p className="text-red-200 text-sm">
          <strong>Error:</strong> {error}
        </p>
      </div>
    );
  }

  if (cards.length === 0) {
    return (
      <div className="rounded-xl border border-slate-700 bg-slate-900/50 p-8 text-center">
        <p className="text-slate-300">
          No analytical cards available for this game yet.
        </p>
        <p className="text-slate-400 text-sm mt-2">
          Models may be abstaining due to low confidence or data constraints.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-semibold text-white">
          Analytical Cards ({cards.length})
        </h2>
        {sport && (
          <span className="text-sm text-slate-400">
            {sport}
          </span>
        )}
      </div>

      <div className="grid gap-4 md:grid-cols-1 lg:grid-cols-2">
        {cards.map(card => (
          <Card key={card.id} {...card} />
        ))}
      </div>
    </div>
  );
}
