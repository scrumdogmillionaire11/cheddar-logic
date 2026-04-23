import { toSqlUtc } from '@/lib/games/query-builder';
import type { LifecycleMode } from './route-handler';

export type GamesQueryWindow = {
  nowUtc: string;
  todayUtc: string;
  lookbackUtc: string | null;
  gamesStartUtc: string;
  activeStartUtc: string;
  gamesEndUtc: string | null;
  shouldUseDevLookback: boolean;
};

export function resolveGamesQueryWindow(params: {
  now: Date;
  lifecycleMode: LifecycleMode;
  isDev: boolean;
  enableDevPastGames: boolean;
  devLookbackHours: number;
  hasApiGamesHorizon: boolean;
  apiGamesHorizonHours: number;
}): GamesQueryWindow {
  const nowUtc = toSqlUtc(params.now);
  const etDateStr = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
  }).format(params.now);
  const tzPart = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    timeZoneName: 'shortOffset',
  })
    .formatToParts(params.now)
    .find((part) => part.type === 'timeZoneName')!.value;
  const offsetHours = parseInt(tzPart.replace('GMT', '') || '-5', 10);
  const sign = offsetHours < 0 ? '-' : '+';
  const absHours = Math.abs(offsetHours).toString().padStart(2, '0');
  const localMidnight = new Date(
    `${etDateStr}T00:00:00${sign}${absHours}:00`,
  );
  const todayUtc = localMidnight
    .toISOString()
    .substring(0, 19)
    .replace('T', ' ');

  const shouldUseDevLookback =
    params.isDev &&
    params.enableDevPastGames &&
    Number.isFinite(params.devLookbackHours) &&
    params.devLookbackHours > 0;

  const lookbackUtc = shouldUseDevLookback
    ? new Date(
        params.now.getTime() - params.devLookbackHours * 60 * 60 * 1000,
      )
        .toISOString()
        .substring(0, 19)
        .replace('T', ' ')
    : null;

  const gamesStartUtc = lookbackUtc ?? todayUtc;
  const activeLookbackHours = Number(
    process.env.ACTIVE_GAMES_LOOKBACK_HOURS || 36,
  );
  const activeStartUtc =
    lookbackUtc ??
    new Date(params.now.getTime() - activeLookbackHours * 60 * 60 * 1000)
      .toISOString()
      .substring(0, 19)
      .replace('T', ' ');
  const gamesEndUtc = params.hasApiGamesHorizon
    ? new Date(
        params.now.getTime() + params.apiGamesHorizonHours * 60 * 60 * 1000,
      )
        .toISOString()
        .substring(0, 19)
        .replace('T', ' ')
    : null;

  return {
    nowUtc,
    todayUtc,
    lookbackUtc,
    gamesStartUtc,
    activeStartUtc,
    gamesEndUtc,
    shouldUseDevLookback,
  };
}

export function resolveGamesQueryStartUtc(params: {
  lifecycleMode: LifecycleMode;
  activeStartUtc: string;
  gamesStartUtc: string;
}): string {
  return params.lifecycleMode === 'active'
    ? params.activeStartUtc
    : params.gamesStartUtc;
}
