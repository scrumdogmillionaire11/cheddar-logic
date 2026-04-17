/**
 * Shared server-side data fetching for Play of the Day.
 * Used by both the API route (app/api/potd/route.ts) and the
 * SSR page (app/play-of-the-day/page.tsx).
 */

import {
  getDatabaseReadOnly,
  closeReadOnlyInstance,
} from '@cheddar-logic/data';
import { ensureDbReady } from '@/lib/db-init';

const ET_TIME_ZONE = 'America/New_York';
const ET_DATE_FORMATTER = new Intl.DateTimeFormat('en-CA', {
  timeZone: ET_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});
const ET_DATE_TIME_FORMATTER = new Intl.DateTimeFormat('en-US', {
  timeZone: ET_TIME_ZONE,
  month: 'short',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
  hour12: true,
});
const ET_PARTS_FORMATTER = new Intl.DateTimeFormat('en-US', {
  timeZone: ET_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
});
const ET_SPORT_ENV: Record<string, string> = {
  NHL: 'ENABLE_NHL_MODEL',
  NBA: 'ENABLE_NBA_MODEL',
  MLB: 'ENABLE_MLB_MODEL',
  NFL: 'ENABLE_NFL_MODEL',
};
const EXCLUDED_GAME_STATUSES = [
  'POSTPONED',
  'CANCELLED',
  'CANCELED',
  'FINAL',
  'CLOSED',
  'COMPLETE',
  'COMPLETED',
  'FT',
] as const;

type PotdPlayRow = {
  id: string;
  play_date: string;
  game_id: string;
  card_id: string;
  sport: string;
  home_team: string;
  away_team: string;
  market_type: string;
  selection: string;
  selection_label: string;
  line: number | null;
  price: number;
  confidence_label: string;
  total_score: number;
  model_win_prob: number;
  implied_prob: number;
  edge_pct: number;
  score_breakdown: string;
  wager_amount: number;
  bankroll_at_post: number;
  kelly_fraction: number;
  game_time_utc: string;
  posted_at: string;
  discord_posted: number;
  discord_posted_at: string | null;
  result: string | null;
  settled_at: string | null;
  pnl_dollars: number | null;
  reasoning: string | null;
};

type PotdNomineeRow = {
  id: number;
  play_date: string;
  nominee_rank: number;
  winner_status: string;
  sport: string;
  game_id: string | null;
  home_team: string | null;
  away_team: string | null;
  market_type: string | null;
  selection_label: string | null;
  line: number | null;
  price: number | null;
  edge_pct: number | null;
  total_score: number | null;
  confidence_label: string | null;
  model_win_prob: number | null;
  game_time_utc: string | null;
  source_type: string;
  created_at: string;
};

export type PotdNominee = {
  rank: number;
  winnerStatus: string;
  sport: string;
  gameId: string | null;
  homeTeam: string | null;
  awayTeam: string | null;
  marketType: string | null;
  selectionLabel: string | null;
  line: number | null;
  price: number | null;
  edgePct: number | null;
  totalScore: number | null;
  confidenceLabel: string | null;
  modelWinProb: number | null;
  gameTimeUtc: string | null;
  gameTimeEtLabel: string;
};

type BankrollAggRow = {
  posted_count: number;
  settled_count: number;
  wins: number;
  losses: number;
  pushes: number;
  net_profit: number | null;
  total_wagered: number | null;
};

type GameRow = {
  game_id: string;
  sport: string;
  game_time_utc: string;
  status: string;
};

type EtDateParts = {
  year: number;
  month: number;
  day: number;
};

export type PotdApiPlay = {
  id: string;
  playDate: string;
  gameId: string;
  cardId: string;
  sport: string;
  homeTeam: string;
  awayTeam: string;
  marketType: string;
  selection: string;
  selectionLabel: string;
  line: number | null;
  price: number;
  confidenceLabel: string;
  totalScore: number;
  modelWinProb: number;
  impliedProb: number;
  edgePct: number;
  scoreBreakdown: Record<string, unknown>;
  wagerAmount: number;
  bankrollAtPost: number;
  kellyFraction: number;
  gameTimeUtc: string;
  gameTimeEtLabel: string;
  postedAt: string;
  discordPosted: boolean;
  discordPostedAt: string | null;
  result: string | null;
  settledAt: string | null;
  pnlDollars: number | null;
  reasoning: string | null;
};

export type PotdBankrollSummary = {
  current: number;
  starting: number;
  netProfit: number;
  postedCount: number;
  settledCount: number;
  wins: number;
  losses: number;
  pushes: number;
  winRate: number | null;
  roi: number | null;
};

export type PotdSchedule = {
  playDate: string;
  published: boolean;
  earliestGameTimeUtc: string;
  earliestGameTimeEtLabel: string;
  targetPostTimeUtc: string;
  targetPostTimeEtLabel: string;
  windowStartTimeUtc: string;
  windowStartTimeEtLabel: string;
  windowEndTimeUtc: string;
  windowEndTimeEtLabel: string;
};

export type PotdResponseData = {
  today: PotdApiPlay | null;
  history: PotdApiPlay[];
  bankroll: PotdBankrollSummary;
  schedule: PotdSchedule | null;
  nominees: PotdNominee[];
  winnerStatus: 'FIRED' | 'NO_PICK' | null;
};

function mapNomineeRow(row: PotdNomineeRow): PotdNominee {
  return {
    rank: row.nominee_rank,
    winnerStatus: row.winner_status,
    sport: row.sport,
    gameId: row.game_id,
    homeTeam: row.home_team,
    awayTeam: row.away_team,
    marketType: row.market_type,
    selectionLabel: row.selection_label,
    line: row.line,
    price: row.price,
    edgePct: row.edge_pct,
    totalScore: row.total_score,
    confidenceLabel: row.confidence_label,
    modelWinProb: row.model_win_prob,
    gameTimeUtc: row.game_time_utc,
    gameTimeEtLabel: formatEtDateTime(row.game_time_utc),
  };
}

function parseJsonObject(value: string | null): Record<string, unknown> {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function formatEtDateTime(value: string | Date | null | undefined): string {
  if (!value) return 'TBD ET';
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return 'TBD ET';
  return `${ET_DATE_TIME_FORMATTER.format(date)} ET`;
}

function getEtDateKey(date: Date): string {
  return ET_DATE_FORMATTER.format(date);
}

function getEtDateParts(date: Date): EtDateParts {
  const parts = ET_PARTS_FORMATTER.formatToParts(date);
  const values = Object.fromEntries(
    parts
      .filter((part) => part.type !== 'literal')
      .map((part) => [part.type, part.value]),
  );

  return {
    year: Number(values.year),
    month: Number(values.month),
    day: Number(values.day),
  };
}

function addDays(parts: EtDateParts, days: number): EtDateParts {
  const date = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + days));
  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
  };
}

function getTimeZoneOffsetMs(date: Date): number {
  const parts = ET_PARTS_FORMATTER.formatToParts(date);
  const values = Object.fromEntries(
    parts
      .filter((part) => part.type !== 'literal')
      .map((part) => [part.type, part.value]),
  );
  const asUtc = Date.UTC(
    Number(values.year),
    Number(values.month) - 1,
    Number(values.day),
    Number(values.hour),
    Number(values.minute),
    Number(values.second),
  );
  return asUtc - date.getTime();
}

function zonedTimeToUtc(parts: EtDateParts, hour = 0, minute = 0): Date {
  const utcGuess = new Date(
    Date.UTC(parts.year, parts.month - 1, parts.day, hour, minute, 0, 0),
  );
  const offsetMs = getTimeZoneOffsetMs(utcGuess);
  return new Date(utcGuess.getTime() - offsetMs);
}

function enabledPotdSports(): string[] {
  return Object.entries(ET_SPORT_ENV)
    .filter(([, envKey]) => process.env[envKey] !== 'false')
    .map(([sport]) => sport);
}

function mapPlayRow(row: PotdPlayRow): PotdApiPlay {
  return {
    id: row.id,
    playDate: row.play_date,
    gameId: row.game_id,
    cardId: row.card_id,
    sport: row.sport,
    homeTeam: row.home_team,
    awayTeam: row.away_team,
    marketType: row.market_type,
    selection: row.selection,
    selectionLabel: row.selection_label,
    line: row.line,
    price: row.price,
    confidenceLabel: row.confidence_label,
    totalScore: row.total_score,
    modelWinProb: row.model_win_prob,
    impliedProb: row.implied_prob,
    edgePct: row.edge_pct,
    scoreBreakdown: parseJsonObject(row.score_breakdown),
    wagerAmount: row.wager_amount,
    bankrollAtPost: row.bankroll_at_post,
    kellyFraction: row.kelly_fraction,
    gameTimeUtc: row.game_time_utc,
    gameTimeEtLabel: formatEtDateTime(row.game_time_utc),
    postedAt: row.posted_at,
    discordPosted: Boolean(row.discord_posted),
    discordPostedAt: row.discord_posted_at,
    result: row.result,
    settledAt: row.settled_at,
    pnlDollars: row.pnl_dollars,
    reasoning: row.reasoning ?? null,
  };
}

function buildBankrollSummary(
  latestAmountAfter: number,
  startingAmountAfter: number,
  aggregates: BankrollAggRow,
): PotdBankrollSummary {
  const settledCount = Number(aggregates.settled_count || 0);
  const wins = Number(aggregates.wins || 0);
  const losses = Number(aggregates.losses || 0);
  const totalWagered = Number(aggregates.total_wagered || 0);
  const netProfit = Number(aggregates.net_profit || 0);

  return {
    current: Number(latestAmountAfter || 0),
    starting: Number(startingAmountAfter || 0),
    netProfit,
    postedCount: Number(aggregates.posted_count || 0),
    settledCount,
    wins,
    losses,
    pushes: Number(aggregates.pushes || 0),
    winRate: settledCount > 0 ? wins / settledCount : null,
    roi: totalWagered > 0 ? netProfit / totalWagered : null,
  };
}

function buildSchedule(
  todayPlay: PotdApiPlay | null,
  todayGames: GameRow[],
  now: Date,
): PotdSchedule | null {
  const eligibleSports = new Set(enabledPotdSports());
  const eligibleGames = todayGames.filter((game) =>
    eligibleSports.has(String(game.sport || '').toUpperCase()),
  );

  if (eligibleGames.length === 0) return null;

  const earliestGame = eligibleGames
    .map((game) => new Date(game.game_time_utc))
    .filter((date) => !Number.isNaN(date.getTime()))
    .sort((left, right) => left.getTime() - right.getTime())[0];

  if (!earliestGame) return null;

  const todayEt = getEtDateParts(now);
  const windowStart = zonedTimeToUtc(todayEt, 12, 0);
  const windowEnd = zonedTimeToUtc(todayEt, 16, 0);
  // Guard 3: MLB day games (e.g. 1:05 PM ET) would produce an 11:35 AM target —
  // before the window opens. Any game kicking off before 1:30 PM ET snaps to windowStart.
  const windowOpenThreshold = zonedTimeToUtc(todayEt, 13, 30);
  let clampedTarget: Date;
  if (earliestGame < windowOpenThreshold) {
    clampedTarget = windowStart;
  } else {
    const targetPostTime = new Date(earliestGame.getTime() - 90 * 60 * 1000);
    clampedTarget =
      targetPostTime < windowStart
        ? windowStart
        : targetPostTime > windowEnd
          ? windowEnd
          : targetPostTime;
  }

  return {
    playDate: getEtDateKey(now),
    published: Boolean(todayPlay),
    earliestGameTimeUtc: earliestGame.toISOString(),
    earliestGameTimeEtLabel: formatEtDateTime(earliestGame),
    targetPostTimeUtc: clampedTarget.toISOString(),
    targetPostTimeEtLabel: formatEtDateTime(clampedTarget),
    windowStartTimeUtc: windowStart.toISOString(),
    windowStartTimeEtLabel: formatEtDateTime(windowStart),
    windowEndTimeUtc: windowEnd.toISOString(),
    windowEndTimeEtLabel: formatEtDateTime(windowEnd),
  };
}

export async function getPotdResponseData(now = new Date()): Promise<PotdResponseData> {
  let db: ReturnType<typeof getDatabaseReadOnly> | null = null;
  try {
    await ensureDbReady();
    db = getDatabaseReadOnly();

    const todayDateKey = getEtDateKey(now);
    const dayParts = getEtDateParts(now);
    const nextDayParts = addDays(dayParts, 1);
    const dayStartUtc = zonedTimeToUtc(dayParts, 0, 0).toISOString();
    const nextDayStartUtc = zonedTimeToUtc(nextDayParts, 0, 0).toISOString();

    const todayRow = (db
      .prepare(
        `SELECT *
         FROM potd_plays
         WHERE play_date = ?
         LIMIT 1`,
      )
      .get(todayDateKey) as PotdPlayRow | undefined) ?? null;

    const historyRows = (db
      .prepare(
        `SELECT *
         FROM potd_plays
         WHERE play_date != ?
         ORDER BY play_date DESC
         LIMIT 12`,
      )
      .all(todayDateKey) as PotdPlayRow[]).map(mapPlayRow);

    const latestLedgerRow =
      db
        .prepare(
          `SELECT amount_after
           FROM potd_bankroll
           ORDER BY datetime(created_at) DESC, id DESC
           LIMIT 1`,
        )
        .get() || null;
    const startingLedgerRow =
      db
        .prepare(
          `SELECT amount_after
           FROM potd_bankroll
           WHERE event_type = 'initial'
           ORDER BY datetime(created_at) ASC, id ASC
           LIMIT 1`,
        )
        .get() || null;
    const aggregateRow =
      (db
        .prepare(
          `SELECT
             COUNT(*) AS posted_count,
             SUM(CASE WHEN result IS NOT NULL THEN 1 ELSE 0 END) AS settled_count,
             SUM(CASE WHEN LOWER(COALESCE(result, '')) = 'win' THEN 1 ELSE 0 END) AS wins,
             SUM(CASE WHEN LOWER(COALESCE(result, '')) = 'loss' THEN 1 ELSE 0 END) AS losses,
             SUM(CASE WHEN LOWER(COALESCE(result, '')) = 'push' THEN 1 ELSE 0 END) AS pushes,
             SUM(COALESCE(pnl_dollars, 0)) AS net_profit,
             SUM(CASE WHEN result IS NOT NULL THEN wager_amount ELSE 0 END) AS total_wagered
           FROM potd_plays`,
        )
        .get() as BankrollAggRow | undefined) ?? {
        posted_count: 0,
        settled_count: 0,
        wins: 0,
        losses: 0,
        pushes: 0,
        net_profit: 0,
        total_wagered: 0,
      };

    const statusPlaceholders = EXCLUDED_GAME_STATUSES.map(() => '?').join(', ');
    const todayGames = db
      .prepare(
        `SELECT game_id, sport, game_time_utc, status
         FROM games
         WHERE game_time_utc >= ?
           AND game_time_utc < ?
           AND UPPER(COALESCE(status, '')) NOT IN (${statusPlaceholders})
         ORDER BY datetime(game_time_utc) ASC`,
      )
      .all(
        dayStartUtc,
        nextDayStartUtc,
        ...EXCLUDED_GAME_STATUSES,
      ) as GameRow[];

    // Nominees: on FIRED days exclude rank 1 (already shown as featured play).
    // On NO_PICK days include all ranks.
    const nomineesRows = (db
      .prepare(
        `SELECT *
         FROM potd_nominees
         WHERE play_date = ?
           AND (winner_status != 'FIRED' OR nominee_rank > 1)
         ORDER BY nominee_rank ASC
         LIMIT 5`,
      )
      .all(todayDateKey) as PotdNomineeRow[]).map(mapNomineeRow);

    const winnerStatusRow =
      (db
        .prepare(
          `SELECT winner_status FROM potd_nominees WHERE play_date = ? LIMIT 1`,
        )
        .get(todayDateKey) as { winner_status: string } | undefined) ?? null;

    const winnerStatus: 'FIRED' | 'NO_PICK' | null =
      winnerStatusRow?.winner_status === 'FIRED' ? 'FIRED'
      : winnerStatusRow?.winner_status === 'NO_PICK' ? 'NO_PICK'
      : null;

    const todayPlay = todayRow ? mapPlayRow(todayRow) : null;
    const bankrollSummary = buildBankrollSummary(
      Number(latestLedgerRow?.amount_after || 0),
      Number(startingLedgerRow?.amount_after || 0),
      aggregateRow,
    );
    const schedule = buildSchedule(todayPlay, todayGames, now);

    return {
      today: todayPlay,
      history: historyRows,
      bankroll: bankrollSummary,
      schedule,
      nominees: nomineesRows,
      winnerStatus,
    };
  } finally {
    if (db) closeReadOnlyInstance(db);
  }
}
