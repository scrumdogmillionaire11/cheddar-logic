import { toSqlUtc } from '@/lib/games/query-builder';
import type { LifecycleMode } from './route-handler';

export type GamesQueryWindow = {
  nowUtc: string;
  todayUtc: string;
  yesterdayUtc: string;
  gamesStartUtc: string;
  activeStartUtc: string;
  gamesEndUtc: string;
};

export function resolveGamesQueryWindow(params: {
  now: Date;
  lifecycleMode: LifecycleMode;
}): GamesQueryWindow {
  const nowUtc = toSqlUtc(params.now);

  // Compute today's date in America/New_York timezone
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

  // Today midnight ET (start of the current ET calendar day)
  const localMidnight = new Date(`${etDateStr}T00:00:00${sign}${absHours}:00`);
  const todayUtc = localMidnight.toISOString().substring(0, 19).replace('T', ' ');

  // Yesterday midnight ET — active mode start boundary so late-night in-progress
  // games (scheduled before today's ET midnight) remain visible.
  const yesterdayUtc = new Date(localMidnight.getTime() - 24 * 60 * 60 * 1000)
    .toISOString()
    .substring(0, 19)
    .replace('T', ' ');

  // Horizon end: 23:59:59 ET on tomorrow = start of (ET day + 2) minus 1 second.
  // This is the canonical MLB tomorrow-visibility rule (horizon-contract v1).
  // Sample ET offset at "day+2 17:00 UTC" (noon ET) to correctly handle DST transitions.
  const [etYear, etMonth, etDay] = etDateStr.split('-').map(Number);
  const dayPlusTwoNoon = new Date(Date.UTC(etYear, etMonth - 1, etDay + 2, 17, 0, 0));
  const futureTzPart = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    timeZoneName: 'shortOffset',
  })
    .formatToParts(dayPlusTwoNoon)
    .find((part) => part.type === 'timeZoneName')!.value;
  const futureOffsetHours = parseInt(futureTzPart.replace('GMT', '') || '-5', 10);
  const futureSign = futureOffsetHours < 0 ? '-' : '+';
  const futureAbsHours = Math.abs(futureOffsetHours).toString().padStart(2, '0');
  const dayPlusTwoDateStr = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
  }).format(dayPlusTwoNoon);
  // Midnight of day+2 in ET, minus 1 second = 23:59:59 of tomorrow in ET
  const dayPlusTwoMidnight = new Date(
    `${dayPlusTwoDateStr}T00:00:00${futureSign}${futureAbsHours}:00`,
  );
  const gamesEndUtc = new Date(dayPlusTwoMidnight.getTime() - 1000)
    .toISOString()
    .substring(0, 19)
    .replace('T', ' ');

  const gamesStartUtc = todayUtc;
  const activeStartUtc = yesterdayUtc;

  return {
    nowUtc,
    todayUtc,
    yesterdayUtc,
    gamesStartUtc,
    activeStartUtc,
    gamesEndUtc,
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
