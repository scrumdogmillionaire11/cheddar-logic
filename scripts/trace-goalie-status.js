#!/usr/bin/env node

'use strict';

function parseArgs(argv) {
  const args = {
    home: null,
    away: null,
    gameTime: null,
    apiUrl: null,
  };

  for (let index = 2; index < argv.length; index += 1) {
    const token = argv[index];
    const next = argv[index + 1];
    if (token === '--home') {
      args.home = next;
      index += 1;
    } else if (token === '--away') {
      args.away = next;
      index += 1;
    } else if (token === '--game-time') {
      args.gameTime = next;
      index += 1;
    } else if (token === '--api-url') {
      args.apiUrl = next;
      index += 1;
    }
  }

  return args;
}

function required(value, key) {
  if (!value || typeof value !== 'string') {
    throw new Error(`Missing required argument --${key}`);
  }
  return value;
}

function safeParseJson(value) {
  if (!value) return {};
  try {
    return JSON.parse(value);
  } catch {
    return {};
  }
}

function findRawRotowireRecord(rawByDate, homeResolution, awayResolution) {
  const dateKey =
    homeResolution?.diagnostics?.raw_source_date_key_used ||
    awayResolution?.diagnostics?.raw_source_date_key_used ||
    homeResolution?.diagnostics?.primary_date_key ||
    awayResolution?.diagnostics?.primary_date_key ||
    null;

  const rows = dateKey ? rawByDate?.[dateKey] || [] : [];
  if (!Array.isArray(rows) || rows.length === 0) {
    return { dateKey, row: null };
  }

  const homeName = homeResolution?.goalie?.name || null;
  const awayName = awayResolution?.goalie?.name || null;

  const matched = rows.find((row) => {
    const homePlayer = String(row?.homePlayer || '');
    const visitPlayer = String(row?.visitPlayer || '');
    return (
      (homeName && (homePlayer === homeName || visitPlayer === homeName)) ||
      (awayName && (homePlayer === awayName || visitPlayer === awayName))
    );
  });

  return {
    dateKey,
    row: matched || rows[0],
  };
}

function pickDescriptor(descriptors, cardType) {
  return descriptors.find((descriptor) => descriptor.cardType === cardType) || null;
}

function getGoalieDriverInputs(descriptors) {
  const certainty = pickDescriptor(descriptors, 'nhl-goalie-certainty');
  const pace = pickDescriptor(descriptors, 'nhl-pace-totals');
  const firstPeriod = pickDescriptor(descriptors, 'nhl-pace-1p');

  return {
    goalie_certainty: certainty?.driverInputs || null,
    pace_totals: pace?.driverInputs || null,
    pace_1p: firstPeriod?.driverInputs || null,
  };
}

async function fetchApiCheckpoint(apiUrl, homeTeam, awayTeam, gameTimeUtc) {
  if (!apiUrl) return { skipped: true, reason: 'no_api_url_provided' };

  const response = await fetch(apiUrl);
  const body = await response.json();
  const rows = Array.isArray(body) ? body : body?.games || body?.data || [];

  if (!Array.isArray(rows)) {
    return { skipped: true, reason: 'unexpected_api_shape', payload: body };
  }

  const match = rows.find((row) => {
    const home = String(row?.home_team || row?.homeTeam || '').toUpperCase();
    const away = String(row?.away_team || row?.awayTeam || '').toUpperCase();
    const start = String(row?.start_time_utc || row?.game_time_utc || '').slice(0, 16);
    return (
      home.includes(homeTeam.toUpperCase()) &&
      away.includes(awayTeam.toUpperCase()) &&
      (!gameTimeUtc || start === String(gameTimeUtc).slice(0, 16))
    );
  });

  return {
    skipped: false,
    game: match || null,
  };
}

async function main() {
  const moneypuckModule = await import('../apps/worker/src/moneypuck.js');
  const modelsModule = await import('../apps/worker/src/models/index.js');
  const moneypuck = moneypuckModule.default || moneypuckModule;
  const models = modelsModule.default || modelsModule;
  const {
    fetchMoneyPuckSnapshot,
    fetchRotowireGoaliesSnapshot,
    enrichOddsSnapshotWithMoneyPuck,
    normalizeRotowireGoalieStatus,
    resolveRotowireGoalieForGameDetailed,
  } = moneypuck;
  const {
    computeNHLDriverCards,
    computeNHLMarketDecisions,
    selectExpressionChoice,
    buildMarketPayload,
    generateCard,
  } = models;

  const args = parseArgs(process.argv);
  const homeTeam = required(args.home, 'home');
  const awayTeam = required(args.away, 'away');
  const gameTimeUtc = required(args.gameTime, 'game-time');

  const now = new Date(gameTimeUtc);
  const rotowireSnapshot = await fetchRotowireGoaliesSnapshot({
    now,
    includeRawRecords: true,
  });
  const moneyPuckSnapshot = await fetchMoneyPuckSnapshot({ ttlMs: 0 });

  const snapshot = {
    ...moneyPuckSnapshot,
    rotowire_goalies: rotowireSnapshot.teams || {},
    rotowire_goalies_by_date: rotowireSnapshot.byDate || {},
  };

  const homeResolution = resolveRotowireGoalieForGameDetailed(
    snapshot,
    homeTeam,
    gameTimeUtc,
  );
  const awayResolution = resolveRotowireGoalieForGameDetailed(
    snapshot,
    awayTeam,
    gameTimeUtc,
  );

  const rawRotowire = findRawRotowireRecord(
    rotowireSnapshot.rawByDate || {},
    homeResolution,
    awayResolution,
  );

  const oddsSnapshot = {
    home_team: homeTeam,
    away_team: awayTeam,
    game_time_utc: gameTimeUtc,
    total: 6.0,
    raw_data: JSON.stringify({}),
  };

  const enriched = await enrichOddsSnapshotWithMoneyPuck(oddsSnapshot, {
    snapshot,
  });
  const rawData = safeParseJson(enriched.raw_data);

  const descriptors = computeNHLDriverCards('trace-game', enriched);
  const marketDecisions = computeNHLMarketDecisions(descriptors, enriched);
  const expressionChoice = selectExpressionChoice(marketDecisions);
  const marketPayload = buildMarketPayload({
    decisions: marketDecisions,
    expressionChoice,
  });

  const paceDescriptor = pickDescriptor(descriptors, 'nhl-pace-totals');
  const generatedCard = paceDescriptor
    ? generateCard({
        sport: 'NHL',
        gameId: 'trace-game',
        descriptor: paceDescriptor,
        oddsSnapshot: enriched,
        marketPayload,
        now: new Date().toISOString(),
      })
    : null;

  const apiCheckpoint = await fetchApiCheckpoint(
    args.apiUrl,
    homeTeam,
    awayTeam,
    gameTimeUtc,
  );

  const checkpoints = {
    game: {
      home_team: homeTeam,
      away_team: awayTeam,
      game_time_utc: gameTimeUtc,
    },
    raw_rotowire_record: rawRotowire,
    home_resolution: {
      raw_source_date_key_used: homeResolution?.diagnostics?.raw_source_date_key_used || null,
      alternate_date_keys_checked:
        homeResolution?.diagnostics?.alternate_date_keys_checked || [],
      fallback_path: homeResolution?.diagnostics?.resolution_path || null,
      fallback_reasons: homeResolution?.diagnostics?.fallback_reason_codes || [],
      normalized_status_token: normalizeRotowireGoalieStatus(homeResolution?.goalie?.status),
      resolved_goalie_name: homeResolution?.goalie?.name || null,
    },
    away_resolution: {
      raw_source_date_key_used: awayResolution?.diagnostics?.raw_source_date_key_used || null,
      alternate_date_keys_checked:
        awayResolution?.diagnostics?.alternate_date_keys_checked || [],
      fallback_path: awayResolution?.diagnostics?.resolution_path || null,
      fallback_reasons: awayResolution?.diagnostics?.fallback_reason_codes || [],
      normalized_status_token: normalizeRotowireGoalieStatus(awayResolution?.goalie?.status),
      resolved_goalie_name: awayResolution?.goalie?.name || null,
    },
    raw_data_goalie_fields: {
      goalie_home_status: rawData.goalie_home_status ?? null,
      goalie_away_status: rawData.goalie_away_status ?? null,
      goalie_home_source_markers: rawData.goalie_home_source_markers || [],
      goalie_away_source_markers: rawData.goalie_away_source_markers || [],
      rotowire_resolution: rawData.rotowire_resolution || null,
    },
    resolve_goalie_certainty_output: {
      home: descriptors.find((item) => item.cardType === 'nhl-goalie-certainty')
        ?.driverInputs?.home_goalie_certainty,
      away: descriptors.find((item) => item.cardType === 'nhl-goalie-certainty')
        ?.driverInputs?.away_goalie_certainty,
    },
    proxy_values: {
      home_goalie_confirmed: descriptors.find((item) => item.cardType === 'nhl-goalie-certainty')
        ?.driverInputs?.home_goalie_confirmed,
      away_goalie_confirmed: descriptors.find((item) => item.cardType === 'nhl-goalie-certainty')
        ?.driverInputs?.away_goalie_confirmed,
    },
    driver_inputs_goalie: getGoalieDriverInputs(descriptors),
    card_payload_goalie_fields: generatedCard
      ? {
          goalie_home_name: generatedCard.payloadData?.goalie_home_name ?? null,
          goalie_away_name: generatedCard.payloadData?.goalie_away_name ?? null,
          goalie_home_status: generatedCard.payloadData?.goalie_home_status ?? null,
          goalie_away_status: generatedCard.payloadData?.goalie_away_status ?? null,
        }
      : null,
    model_input_fields: paceDescriptor
      ? {
          home_goalie_confirmed: paceDescriptor.driverInputs?.home_goalie_confirmed,
          away_goalie_confirmed: paceDescriptor.driverInputs?.away_goalie_confirmed,
          home_goalie_certainty: paceDescriptor.driverInputs?.home_goalie_certainty,
          away_goalie_certainty: paceDescriptor.driverInputs?.away_goalie_certainty,
          home_goalie_name: paceDescriptor.driverInputs?.home_goalie_name,
          away_goalie_name: paceDescriptor.driverInputs?.away_goalie_name,
        }
      : null,
    final_api_output: apiCheckpoint,
  };

  process.stdout.write(`${JSON.stringify(checkpoints, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`[trace-goalie-status] ${error.message}\n`);
  process.exitCode = 1;
});
