/**
 * GET /api/team-metrics
 *
 * Query params:
 * - sport: required (NBA | NCAAM | NHL)
 * - team: optional single team name
 * - home_team: optional team name (paired with away_team)
 * - away_team: optional team name (paired with home_team)
 * - include_games: optional (true/false), default false
 * - limit: optional (default 5, max 10)
 */

import { NextRequest, NextResponse } from 'next/server';
import { getTeamMetricsWithGames } from '@cheddar-logic/data';

export const runtime = 'nodejs';

function parseBoolean(value: string | null) {
  if (!value) return false;
  return ['true', '1', 'yes'].includes(value.toLowerCase());
}

function clampNumber(value: string | null, fallback: number, min: number, max: number) {
  const parsed = value ? Number.parseInt(value, 10) : NaN;
  if (Number.isNaN(parsed)) return fallback;
  return Math.min(Math.max(parsed, min), max);
}

function normalizeSport(value: string | null) {
  if (!value) return null;
  const normalized = value.trim().toUpperCase();
  if (normalized === 'NCAAB' || normalized === 'NCAA') return 'NCAAM';
  if (['NBA', 'NCAAM', 'NHL'].includes(normalized)) return normalized;
  return null;
}

async function buildTeamResponse(teamName: string, sport: string, includeGames: boolean, limit: number) {
  const snapshot = await getTeamMetricsWithGames(teamName, sport, { includeGames, limit });
  return {
    name: teamName,
    metrics: snapshot.metrics,
    teamInfo: snapshot.teamInfo,
    games: snapshot.games
  };
}

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = request.nextUrl;
    const sport = normalizeSport(searchParams.get('sport'));
    if (!sport) {
      return NextResponse.json(
        { success: false, error: 'sport is required (NBA | NCAAM | NHL)' },
        { status: 400 }
      );
    }

    const team = searchParams.get('team');
    const homeTeam = searchParams.get('home_team');
    const awayTeam = searchParams.get('away_team');
    const includeGames = parseBoolean(searchParams.get('include_games'));
    const limit = clampNumber(searchParams.get('limit'), 5, 1, 10);

    if (!team && !homeTeam && !awayTeam) {
      return NextResponse.json(
        { success: false, error: 'team or home_team/away_team is required' },
        { status: 400 }
      );
    }

    if (team && (homeTeam || awayTeam)) {
      return NextResponse.json(
        { success: false, error: 'use team or home_team/away_team, not both' },
        { status: 400 }
      );
    }

    const fetchedAt = new Date().toISOString();

    if (team) {
      const teamData = await buildTeamResponse(team, sport, includeGames, limit);
      return NextResponse.json(
        {
          success: true,
          data: {
            sport,
            source: 'espn',
            window_games: limit,
            fetched_at: fetchedAt,
            team: teamData
          }
        },
        { headers: { 'Content-Type': 'application/json' } }
      );
    }

    const [homeData, awayData] = await Promise.all([
      homeTeam ? buildTeamResponse(homeTeam, sport, includeGames, limit) : null,
      awayTeam ? buildTeamResponse(awayTeam, sport, includeGames, limit) : null
    ]);

    return NextResponse.json(
      {
        success: true,
        data: {
          sport,
          source: 'espn',
          window_games: limit,
          fetched_at: fetchedAt,
          home: homeData,
          away: awayData
        }
      },
      { headers: { 'Content-Type': 'application/json' } }
    );
  } catch (error) {
    console.error('[API] Error fetching team metrics:', error);
    const message = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json(
      { success: false, error: message },
      { status: 500 }
    );
  }
}
