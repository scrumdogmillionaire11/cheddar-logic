import type { GameRow, LifecycleMode, Play } from './route-handler';

function hasDisplayableOdds(row: GameRow): boolean {
  return (
    row.h2h_home !== null ||
    row.h2h_away !== null ||
    row.total !== null ||
    row.spread_home !== null ||
    row.spread_away !== null
  );
}

function isProjectionOnlyPropPlay(play: Play): boolean {
  return (
    play.market_type === 'PROP' &&
    (play.execution_status === 'PROJECTION_ONLY' ||
      play.status === 'PASS' ||
      play.action === 'PASS')
  );
}

function hasDisplayablePregamePlays(row: GameRow, plays: Play[]): boolean {
  if (plays.length === 0) return false;

  // NHL prop-only projection rows can manufacture false pregame listings when
  // a bad schedule row survives briefly without odds. Keep non-prop markets and
  // bettable prop rows eligible, but fail closed on projection-only prop-only rows.
  if (String(row.sport || '').toUpperCase() === 'NHL') {
    return plays.some((play) => !isProjectionOnlyPropPlay(play));
  }

  return true;
}

export type GamesServiceRowsResult = {
  responseRows: GameRow[];
  deduplicatedRows: GameRow[];
  pregameRowsDroppedNoOddsNoPlays: number;
};

export function prepareGamesServiceRows(params: {
  rows: GameRow[];
  lifecycleMode: LifecycleMode;
  playsMap: Map<string, Play[]>;
}): GamesServiceRowsResult {
  const { rows, lifecycleMode, playsMap } = params;
  const pregameRowsDroppedNoOddsNoPlays =
    lifecycleMode === 'pregame'
      ? rows.reduce((count, row) => {
          const hasOdds = hasDisplayableOdds(row);
          const plays = playsMap.get(row.game_id) ?? [];
          const hasPlays = hasDisplayablePregamePlays(row, plays);
          const hasIngestFailure = Boolean(row.ingest_failure_reason_code);
          return !hasOdds && !hasPlays && !hasIngestFailure
            ? count + 1
            : count;
        }, 0)
      : 0;

  const responseRows =
    lifecycleMode === 'pregame'
      ? rows.filter((row) => {
          const hasOdds = hasDisplayableOdds(row);
          const plays = playsMap.get(row.game_id) ?? [];
          const hasPlays = hasDisplayablePregamePlays(row, plays);
          const hasIngestFailure = Boolean(row.ingest_failure_reason_code);
          return hasOdds || hasPlays || hasIngestFailure;
        })
      : rows;

  const deduplicatedRows = dedupeGamesByMatchup({
    responseRows,
    playsMap,
  });

  return {
    responseRows,
    deduplicatedRows,
    pregameRowsDroppedNoOddsNoPlays,
  };
}

function dedupeGamesByMatchup(params: {
  responseRows: GameRow[];
  playsMap: Map<string, Play[]>;
}): GameRow[] {
  const byMatchup = new Map<string, GameRow[]>();
  for (const row of params.responseRows) {
    const key = `${row.sport}|${row.away_team.toUpperCase()}|${row.home_team.toUpperCase()}|${row.game_time_utc.substring(0, 10)}`;
    const bucket = byMatchup.get(key);
    if (bucket) {
      bucket.push(row);
    } else {
      byMatchup.set(key, [row]);
    }
  }

  const result: GameRow[] = [];
  for (const group of byMatchup.values()) {
    if (group.length === 1) {
      result.push(group[0]);
      continue;
    }
    group.sort((a, b) => {
      const aKey = a.odds_captured_at ?? a.created_at;
      const bKey = b.odds_captured_at ?? b.created_at;
      return bKey < aKey ? -1 : bKey > aKey ? 1 : 0;
    });
    const winner = group[0];
    for (let i = 1; i < group.length; i += 1) {
      const loserId = group[i].game_id;
      const loserPlays = params.playsMap.get(loserId);
      if (!loserPlays || loserPlays.length === 0) continue;

      const winnerPlays = params.playsMap.get(winner.game_id);
      if (winnerPlays) {
        winnerPlays.push(...loserPlays);
      } else {
        params.playsMap.set(winner.game_id, [...loserPlays]);
      }
      params.playsMap.delete(loserId);
    }
    result.push(winner);
  }
  return result;
}
