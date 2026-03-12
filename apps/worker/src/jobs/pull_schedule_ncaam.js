/**
 * Pull Schedule (NCAAM) Job
 *
 * Fetches ESPN scoreboard by date range and upserts games into the schedule
 * table (games), independent of odds. This enables team sequence logic
 * like Welcome Home Fade.
 *
 * Usage:
 *   node src/jobs/pull_schedule_ncaam.js
 *   node src/jobs/pull_schedule_ncaam.js --dry-run
 */

'use strict';

require('dotenv').config();
const { v4: uuidV4 } = require('uuid');

const {
  insertJobRun,
  markJobRunSuccess,
  markJobRunFailure,
  shouldRunJobKey,
  upsertGame,
  upsertGameIdMap,
  getDatabase,
  withDb,
} = require('@cheddar-logic/data');

const {
  fetchScoreboardEvents,
} = require('../../../../packages/data/src/espn-client');

const SPORT = 'ncaam';
const ESPN_LEAGUE = 'basketball/mens-college-basketball';
const BACKFILL_DAYS = Number(process.env.NCAAM_SCHEDULE_BACKFILL_DAYS || 60);
const FORWARD_DAYS = Number(process.env.NCAAM_SCHEDULE_FORWARD_DAYS || 30);
const FUZZY_MATCH_MAX_DELTA_MINUTES = 90;
const LARGE_DELTA_REPAIR_CONFIDENCE = 0.6;

function toDateKeyUtc(date) {
  return date.toISOString().slice(0, 10).replace(/-/g, '');
}

function buildDateRangeUtc(startDate, endDate) {
  const days = [];
  const cursor = new Date(startDate.getTime());
  while (cursor <= endDate) {
    days.push(toDateKeyUtc(cursor));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return days;
}

function normalizeStatus(statusType) {
  const state = statusType?.state;
  if (state === 'pre') return 'scheduled';
  if (state === 'in') return 'in_progress';
  if (state === 'post') return 'final';
  return 'scheduled';
}

function normalizeEvent(event) {
  const comp = event?.competitions?.[0];
  if (!comp) return null;

  const homeComp = comp.competitors?.find((c) => c.homeAway === 'home');
  const awayComp = comp.competitors?.find((c) => c.homeAway === 'away');
  if (!homeComp || !awayComp) return null;

  const homeTeam = homeComp.team?.displayName;
  const awayTeam = awayComp.team?.displayName;
  const gameTimeUtc = event.date || comp.date;
  if (!homeTeam || !awayTeam || !gameTimeUtc || !event.id) return null;

  return {
    gameId: String(event.id),
    homeTeam: homeTeam.trim(),
    awayTeam: awayTeam.trim(),
    gameTimeUtc,
    status: normalizeStatus(comp.status?.type),
  };
}

function normalizeTeamName(name) {
  if (!name) return '';
  return name.replace(/\s+/g, ' ').trim().toUpperCase();
}

function scoreMatchConfidence(deltaMinutes) {
  if (deltaMinutes <= 15) return 1.0;
  if (deltaMinutes <= 30) return 0.9;
  if (deltaMinutes <= FUZZY_MATCH_MAX_DELTA_MINUTES) return 0.75;
  return 0;
}

function selectBestCandidate(candidates, target) {
  const targetHome = normalizeTeamName(target.homeTeam);
  const targetAway = normalizeTeamName(target.awayTeam);
  const targetTime = new Date(target.gameTimeUtc).getTime();

  const exactTeamMatches = candidates
    .map((candidate) => {
      const home = normalizeTeamName(candidate.home_team);
      const away = normalizeTeamName(candidate.away_team);
      if (home !== targetHome || away !== targetAway) return null;

      const candidateTime = new Date(candidate.game_time_utc).getTime();
      const deltaMinutes = Math.abs(candidateTime - targetTime) / 60000;
      return {
        candidate,
        deltaMinutes,
        confidence: scoreMatchConfidence(deltaMinutes),
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.deltaMinutes - b.deltaMinutes);

  const fuzzyMatches = exactTeamMatches.filter(
    (match) => match.deltaMinutes <= FUZZY_MATCH_MAX_DELTA_MINUTES,
  );

  if (fuzzyMatches.length > 0) {
    if (
      fuzzyMatches.length > 1 &&
      fuzzyMatches[0].deltaMinutes === fuzzyMatches[1].deltaMinutes
    ) {
      return { status: 'ambiguous', matches: fuzzyMatches };
    }

    return {
      status: 'matched',
      match: fuzzyMatches[0],
      matchMethod: 'teams_time_fuzzy',
      shouldSyncCanonicalTime: true,
    };
  }

  if (exactTeamMatches.length === 0) return { status: 'no_candidate' };

  if (
    exactTeamMatches.length > 1 &&
    exactTeamMatches[0].deltaMinutes === exactTeamMatches[1].deltaMinutes
  ) {
    return { status: 'ambiguous', matches: exactTeamMatches };
  }

  return {
    status: 'matched',
    match: {
      ...exactTeamMatches[0],
      confidence: LARGE_DELTA_REPAIR_CONFIDENCE,
    },
    matchMethod: 'teams_exact_time_repair',
    shouldSyncCanonicalTime: true,
  };
}

async function pullScheduleNcaam({ jobKey = null, dryRun = false } = {}) {
  const jobRunId = `job-pull-schedule-ncaam-${new Date().toISOString().split('.')[0]}-${uuidV4().slice(0, 8)}`;

  console.log(`[Schedule:NCAAM] Starting job run: ${jobRunId}`);
  if (jobKey) console.log(`[Schedule:NCAAM] Job key: ${jobKey}`);
  console.log(`[Schedule:NCAAM] Time: ${new Date().toISOString()}`);

  return withDb(async () => {
    if (jobKey && !shouldRunJobKey(jobKey)) {
      console.log(
        `[Schedule:NCAAM] Skipping (already succeeded or running): ${jobKey}`,
      );
      return { success: true, jobRunId: null, skipped: true, jobKey };
    }

    if (dryRun) {
      console.log(
        '[Schedule:NCAAM] DRY_RUN=true -- would fetch ESPN scoreboards',
      );
      return { success: true, jobRunId: null, dryRun: true, jobKey };
    }

    try {
      insertJobRun('pull_schedule_ncaam', jobRunId, jobKey);

      const now = new Date();
      const start = new Date(
        Date.UTC(
          now.getUTCFullYear(),
          now.getUTCMonth(),
          now.getUTCDate() - BACKFILL_DAYS,
        ),
      );
      const end = new Date(
        Date.UTC(
          now.getUTCFullYear(),
          now.getUTCMonth(),
          now.getUTCDate() + FORWARD_DAYS,
        ),
      );
      const days = buildDateRangeUtc(start, end);
      console.log(
        `[Schedule:NCAAM] Window: backfill=${BACKFILL_DAYS}d forward=${FORWARD_DAYS}d ` +
          `(${days.length} day(s): ${days[0]}..${days[days.length - 1]})`,
      );

      const db = getDatabase();

      let gamesUpserted = 0;
      let daysWithEvents = 0;
      let mappingsCreated = 0;
      let mappingsFailedNoCandidate = 0;
      let mappingsFailedAmbiguous = 0;

      for (let index = 0; index < days.length; index += 1) {
        const day = days[index];
        if (index % 5 === 0 || index === days.length - 1) {
          console.log(
            `[Schedule:NCAAM] Progress: day ${index + 1}/${days.length} (${day})`,
          );
        }

        const events = await fetchScoreboardEvents(ESPN_LEAGUE, day, {
          groups: '50',
          limit: '1000',
        });
        if (!events || events.length === 0) continue;
        daysWithEvents += 1;
        console.log(`[Schedule:NCAAM] ${day}: ${events.length} event(s)`);

        for (const event of events) {
          const normalized = normalizeEvent(event);
          if (!normalized) continue;

          const stableGameId = `game-${SPORT}-${normalized.gameId}`;
          upsertGame({
            id: stableGameId,
            gameId: normalized.gameId,
            sport: SPORT,
            homeTeam: normalized.homeTeam,
            awayTeam: normalized.awayTeam,
            gameTimeUtc: normalized.gameTimeUtc,
            status: normalized.status,
          });
          gamesUpserted += 1;

          const eventTime = new Date(normalized.gameTimeUtc);
          if (Number.isNaN(eventTime.getTime())) {
            mappingsFailedNoCandidate += 1;
            continue;
          }

          const windowStart = new Date(
            eventTime.getTime() - 24 * 60 * 60 * 1000,
          ).toISOString();
          const windowEnd = new Date(
            eventTime.getTime() + 24 * 60 * 60 * 1000,
          ).toISOString();

          // sql.js statements can't be reused, so prepare fresh each time
          const oddsCandidatesStmt = db.prepare(`
            SELECT DISTINCT g.game_id, g.game_time_utc, g.home_team, g.away_team
            FROM games g
            INNER JOIN odds_snapshots o ON o.game_id = g.game_id
            WHERE LOWER(g.sport) = ?
              AND g.game_time_utc >= ?
              AND g.game_time_utc <= ?
          `);
          const candidates = oddsCandidatesStmt.all(
            SPORT,
            windowStart,
            windowEnd,
          );
          const selection = selectBestCandidate(candidates, normalized);

          if (selection.status === 'no_candidate') {
            mappingsFailedNoCandidate += 1;
            continue;
          }

          if (selection.status === 'ambiguous') {
            mappingsFailedAmbiguous += 1;
            continue;
          }

          const match = selection.match;
          if (selection.shouldSyncCanonicalTime) {
            if (match.candidate.game_time_utc !== normalized.gameTimeUtc) {
              console.log(
                `[Schedule:NCAAM] Syncing canonical game time for ${match.candidate.game_id}: ` +
                  `${match.candidate.game_time_utc} -> ${normalized.gameTimeUtc}`,
              );
            }

            upsertGame({
              id: `game-${SPORT}-${match.candidate.game_id}`,
              gameId: match.candidate.game_id,
              sport: SPORT,
              homeTeam: normalized.homeTeam,
              awayTeam: normalized.awayTeam,
              gameTimeUtc: normalized.gameTimeUtc,
              status: normalized.status,
            });
          }

          upsertGameIdMap({
            sport: SPORT,
            provider: 'espn',
            externalGameId: normalized.gameId,
            gameId: match.candidate.game_id,
            matchMethod: selection.matchMethod || 'teams_time_fuzzy',
            matchConfidence: match.confidence,
            matchedAt: new Date().toISOString(),
            extGameTimeUtc: normalized.gameTimeUtc,
            extHomeTeam: normalized.homeTeam,
            extAwayTeam: normalized.awayTeam,
            oddsGameTimeUtc: match.candidate.game_time_utc,
            oddsHomeTeam: match.candidate.home_team,
            oddsAwayTeam: match.candidate.away_team,
          });
          mappingsCreated += 1;
        }
      }

      markJobRunSuccess(jobRunId);
      console.log(
        `[Schedule:NCAAM] OK: upserted ${gamesUpserted} games across ${daysWithEvents}/${days.length} days`,
      );
      console.log(
        `[Schedule:NCAAM] Mapping: created=${mappingsCreated} no_candidate=${mappingsFailedNoCandidate} ambiguous=${mappingsFailedAmbiguous}`,
      );
      return {
        success: true,
        jobRunId,
        jobKey,
        gamesUpserted,
        daysScanned: days.length,
        daysWithEvents,
        mappingsCreated,
        mappingsFailedNoCandidate,
        mappingsFailedAmbiguous,
      };
    } catch (error) {
      console.error('[Schedule:NCAAM] ERROR: job failed:', error.message);
      console.error(error.stack);

      try {
        markJobRunFailure(jobRunId, error.message);
      } catch (dbError) {
        console.error(
          `[Schedule:NCAAM] Failed to record error to DB:`,
          dbError.message,
        );
      }

      return { success: false, jobRunId, jobKey, error: error.message };
    }
  });
}

if (require.main === module) {
  const dryRun = process.argv.includes('--dry-run');
  pullScheduleNcaam({ dryRun })
    .then((result) => process.exit(result.success ? 0 : 1))
    .catch((err) => {
      console.error('Unhandled error:', err);
      process.exit(1);
    });
}

module.exports = {
  pullScheduleNcaam,
  __private: {
    normalizeTeamName,
    scoreMatchConfidence,
    selectBestCandidate,
  },
};
