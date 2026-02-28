'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';

interface Play {
  cardType: string;
  cardTitle: string;
  prediction: 'HOME' | 'AWAY' | 'NEUTRAL';
  confidence: number;
  tier: 'SUPER' | 'BEST' | 'WATCH' | null;
  reasoning: string;
  evPassed: boolean;
  driverKey: string;
}

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
  plays: Play[];
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
  const isInitialLoad = useRef(true);

  useEffect(() => {
    const fetchGames = async () => {
      try {
        if (isInitialLoad.current) {
          setLoading(true);
        }
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
        isInitialLoad.current = false;
      }
    };

    fetchGames();
    // Updates in background every 30s
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

  const getTierBadge = (tier: Play['tier']) => {
    switch (tier) {
      case 'SUPER':
        return (
          <span className="px-2 py-0.5 text-xs font-bold bg-green-700/50 text-green-300 rounded border border-green-600/60">
            SUPER
          </span>
        );
      case 'BEST':
        return (
          <span className="px-2 py-0.5 text-xs font-bold bg-blue-700/50 text-blue-300 rounded border border-blue-600/60">
            BEST
          </span>
        );
      case 'WATCH':
        return (
          <span className="px-2 py-0.5 text-xs font-bold bg-yellow-700/50 text-yellow-300 rounded border border-yellow-600/60">
            WATCH
          </span>
        );
      default:
        return null;
    }
  };

  const getPredictionBadge = (prediction: Play['prediction']) => {
    const colorMap = {
      HOME: 'bg-indigo-700/40 text-indigo-200 border-indigo-600/50',
      AWAY: 'bg-orange-700/40 text-orange-200 border-orange-600/50',
      NEUTRAL: 'bg-white/10 text-cloud/70 border-white/20',
    };
    return (
      <span
        className={`px-2 py-0.5 text-xs font-semibold rounded border ${colorMap[prediction]}`}
      >
        {prediction}
      </span>
    );
  };

  const getPlaySuggestion = (play: Play, odds: GameData['odds']): string | null => {
    if (!odds) return null;
    if (play.prediction === 'HOME') {
      const line = formatOddsLine(odds.h2hHome);
      return `BET HOME ${line}`;
    }
    if (play.prediction === 'AWAY') {
      const line = formatOddsLine(odds.h2hAway);
      return `BET AWAY ${line}`;
    }
    // NEUTRAL = no directional suggestion
    return null;
  };

  const getSuggestionClassName = (tier: Play['tier']): string => {
    if (tier === 'SUPER') return 'text-lg font-bold text-green-200 tracking-wide mb-1';
    if (tier === 'BEST') return 'text-base font-bold text-green-300 tracking-wide mb-1';
    return 'text-sm font-bold text-green-300/80 tracking-wide mb-1';
  };

  return (
    <div className="min-h-screen bg-night text-cloud px-6 py-12">
      <div className="max-w-4xl mx-auto">
        <div className="mb-8 space-y-2">
          <div className="flex items-center justify-between gap-4">
            <h1 className="text-4xl font-bold">🧀 The Cheddar Board 🧀</h1>
            <Link
              href="/"
              className="px-4 py-2 rounded-lg border border-white/20 hover:border-white/40 hover:bg-surface/50 transition"
            >
              Back Home
            </Link>
          </div>
          <p className="text-cloud/70">
            {games.length} game{games.length !== 1 ? 's' : ''} from odds API (updates in background every 30s)
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
              const plays = game.plays ?? [];

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

                  {plays.length > 0 && (
                    <div className="border-t border-white/5 mt-3 pt-3">
                      <p className="text-xs uppercase tracking-widest text-cloud/40 mb-2 font-semibold">
                        Driver Plays
                      </p>
                      <div className="space-y-2">
                        {plays.map((play, idx) => {
                          const suggestion = getPlaySuggestion(play, game.odds);
                          return (
                            <div
                              key={`${play.driverKey}-${idx}`}
                              className="bg-white/5 rounded-md px-3 py-2"
                            >
                              {suggestion && (
                                <p className={getSuggestionClassName(play.tier)}>
                                  {suggestion}
                                </p>
                              )}
                              <div className="flex items-center gap-2 flex-wrap mb-1">
                                {getTierBadge(play.tier)}
                                {getPredictionBadge(play.prediction)}
                                <span className="text-xs font-mono text-cloud/60">
                                  {Math.round(play.confidence * 100)}%
                                </span>
                                <span className="text-xs text-cloud/70 font-medium">
                                  {play.cardTitle}
                                </span>
                              </div>
                              <p className="text-xs text-cloud/50 leading-snug">{play.reasoning}</p>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
