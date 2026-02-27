'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';

interface GameData {
  id: string;
  gameId: string;
  sport: string;
  homeTeam: string;
  awayTeam: string;
  gameTimeUtc: string;
  status: string;
  createdAt: string;
  odds: {
    h2hHome: number | null;
    h2hAway: number | null;
    total: number | null;
    spreadHome: number | null;
    spreadAway: number | null;
    capturedAt: string | null;
  } | null;
}

interface ApiResponse {
  success: boolean;
  data: GameData[];
  error?: string;
}

export default function CardsPage() {
  const [games, setGames] = useState<GameData[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const fetchGames = async () => {
      try {
        setLoading(true);
        const response = await fetch('/api/games');
        const data: ApiResponse = await response.json();

        if (!response.ok || !data.success) {
          setError(data.error || 'Failed to fetch games');
          setGames([]);
          return;
        }

        setGames(data.data || []);
        setError(null);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Unknown error');
        setGames([]);
      } finally {
        setLoading(false);
      }
    };

    fetchGames();
    // Refresh every 30 seconds
    const interval = setInterval(fetchGames, 30000);
    return () => clearInterval(interval);
  }, []);

  const formatDate = (dateStr: string) => {
    try {
      const date = new Date(dateStr);
      return date.toLocaleString('en-US', {
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      });
    } catch {
      return dateStr;
    }
  };

  const formatOddsLine = (value: number | null): string => {
    if (value === null) return '--';
    return value > 0 ? `+${value}` : `${value}`;
  };

  return (
    <div className="min-h-screen bg-night text-cloud px-6 py-12">
      <div className="max-w-4xl mx-auto">
        <div className="mb-8 space-y-2">
          <div className="flex items-center justify-between gap-4">
            <h1 className="text-4xl font-bold">Games</h1>
            <Link
              href="/"
              className="px-4 py-2 rounded-lg border border-white/20 hover:border-white/40 hover:bg-surface/50 transition"
            >
              Back Home
            </Link>
          </div>
          <p className="text-cloud/70">
            {games.length} game{games.length !== 1 ? 's' : ''} from odds API (auto-refreshes every 30 seconds)
          </p>
        </div>

        {loading && <div className="text-center py-8 text-cloud/60">Loading games...</div>}

        {error && (
          <div className="mb-6 p-4 bg-red-900/20 border border-red-700 rounded-lg text-red-200">
            Error: {error}
          </div>
        )}

        {!loading && games.length === 0 && !error && (
          <div className="text-center py-8 text-cloud/60">No games found</div>
        )}

        {!loading && games.length > 0 && (
          <div className="space-y-4">
            {games.map((game) => {
              const gameTime = formatDate(game.gameTimeUtc);
              const isNotScheduled = game.status && game.status !== 'scheduled';

              return (
                <div
                  key={game.id}
                  className="border border-white/10 rounded-lg p-4 bg-surface/30 hover:bg-surface/50 transition"
                >
                  <div className="mb-3 flex items-start justify-between gap-4">
                    <div className="flex-1">
                      <div className="flex items-center gap-3 mb-2">
                        <h3 className="font-semibold text-lg">
                          {game.awayTeam} @ {game.homeTeam}
                        </h3>
                        <span className="px-2 py-1 text-xs font-semibold bg-white/10 text-cloud/80 rounded border border-white/20">
                          {game.sport.toUpperCase()}
                        </span>
                        {isNotScheduled && (
                          <span className="px-2 py-1 text-xs font-semibold bg-blue-600/40 text-blue-200 rounded border border-blue-600/60">
                            {game.status}
                          </span>
                        )}
                      </div>
                      <div className="text-sm text-cloud/70">
                        <span>{gameTime}</span>
                      </div>
                    </div>
                  </div>

                  <div className="border-t border-white/5 pt-3">
                    {game.odds ? (
                      <div className="grid grid-cols-3 gap-4 text-sm">
                        <div>
                          <p className="text-cloud/50 text-xs mb-1">Moneyline</p>
                          <p className="font-mono text-cloud/80">
                            {game.homeTeam.split(' ').slice(-1)[0]} {formatOddsLine(game.odds.h2hHome)}
                            {' / '}
                            {game.awayTeam.split(' ').slice(-1)[0]} {formatOddsLine(game.odds.h2hAway)}
                          </p>
                        </div>
                        <div>
                          <p className="text-cloud/50 text-xs mb-1">Total</p>
                          <p className="font-mono text-cloud/80">
                            {game.odds.total !== null ? `O/U ${game.odds.total}` : '--'}
                          </p>
                        </div>
                        <div>
                          <p className="text-cloud/50 text-xs mb-1">Odds Updated</p>
                          <p className="font-mono text-cloud/80">
                            {game.odds.capturedAt ? formatDate(game.odds.capturedAt) : '--'}
                          </p>
                        </div>
                      </div>
                    ) : (
                      <p className="text-sm text-cloud/40 italic">No odds data</p>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
