'use strict';

const fs = require('fs');
const path = require('path');

const DEFAULT_SOURCE_URL =
  'https://www.teamrankings.com/ncaa-basketball/stat/free-throw-pct';
const DEFAULT_OUTPUT_PATH = path.resolve(
  __dirname,
  '../data/input/teamrankings_ncaam_ft_pct.csv',
);

function decodeHtml(value) {
  if (!value) return '';
  return String(value)
    .replace(/&#(\d+);/g, (_m, code) => String.fromCharCode(Number(code)))
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .trim();
}

function normalizeFtPct(rawValue) {
  const parsed = Number(rawValue);
  if (!Number.isFinite(parsed)) return null;
  const pct = parsed >= 0 && parsed <= 1 ? parsed * 100 : parsed;
  if (pct < 0 || pct > 100) return null;
  return Number(pct.toFixed(1));
}

async function fetchHtml(url) {
  if (typeof fetch !== 'function') {
    throw new Error('global fetch is not available in this Node runtime');
  }
  const response = await fetch(url, {
    headers: {
      'user-agent':
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
      accept:
        'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'accept-language': 'en-US,en;q=0.9',
    },
  });
  if (!response.ok) {
    throw new Error(`TeamRankings request failed: HTTP ${response.status}`);
  }
  return response.text();
}

function resolveSourceUrl(input) {
  const candidate = String(input || process.env.TEAMRANKINGS_NCAAM_FT_URL || '')
    .trim();
  return candidate || DEFAULT_SOURCE_URL;
}

function resolveOutputPath(input) {
  const candidate = String(
    input || process.env.TEAMRANKINGS_NCAAM_FT_CSV_PATH || '',
  ).trim();
  if (!candidate) return DEFAULT_OUTPUT_PATH;
  return path.isAbsolute(candidate)
    ? candidate
    : path.resolve(process.cwd(), candidate);
}

function extractSeasonInfo(html) {
  const selectedOptionMatch = html.match(
    /<option value="([^"]+)"[^>]*\bselected\b[^>]*>([^<]+)<\/option>/i,
  );
  const seasonLabel = decodeHtml(selectedOptionMatch?.[2] || '').trim();
  const sourceDateRaw = selectedOptionMatch?.[1] || '';
  const parsedSourceDate = Date.parse(sourceDateRaw);
  const sourceUpdatedAt = Number.isNaN(parsedSourceDate)
    ? new Date().toISOString()
    : new Date(parsedSourceDate).toISOString();

  return {
    seasonLabel: seasonLabel || null,
    sourceUpdatedAt,
  };
}

function extractRows(html) {
  const tableMatch = html.match(
    /<table class="tr-table datatable scrollable">[\s\S]*?<tbody>([\s\S]*?)<\/tbody>/i,
  );
  if (!tableMatch) {
    throw new Error('could not locate TeamRankings data table body');
  }

  const body = tableMatch[1];
  const rowMatches = body.match(/<tr>[\s\S]*?<\/tr>/gi) || [];
  const rows = [];

  for (const rowHtml of rowMatches) {
    const dataSortMatches = Array.from(
      rowHtml.matchAll(/<td[^>]*data-sort="([^"]*)"[^>]*>/gi),
    ).map((match) => decodeHtml(match[1]));

    if (dataSortMatches.length < 3) continue;
    const teamName = dataSortMatches[1];
    const ftPct = normalizeFtPct(dataSortMatches[2]);
    if (!teamName || ftPct === null) continue;

    rows.push({
      team_name: teamName,
      ft_pct: ftPct,
    });
  }

  return rows;
}

function csvEscape(value) {
  const stringValue = String(value ?? '');
  if (!/[",\n]/.test(stringValue)) return stringValue;
  return `"${stringValue.replace(/"/g, '""')}"`;
}

function toCsv(rows, season, sourceUpdatedAt) {
  const header = 'team_name,ft_pct,season,source_updated_at';
  const lines = rows.map((row) =>
    [
      csvEscape(row.team_name),
      csvEscape(row.ft_pct.toFixed(1)),
      csvEscape(season || ''),
      csvEscape(sourceUpdatedAt),
    ].join(','),
  );
  return [header, ...lines].join('\n') + '\n';
}

function parseArgs(argv) {
  const args = new Set(argv.slice(2));
  return {
    stdout: args.has('--stdout'),
  };
}

async function refreshTeamRankingsNcaamFtCsv(options = {}) {
  const stdout = options.stdout === true;
  const outputPath = resolveOutputPath(options.outputPath);
  const sourceUrl = resolveSourceUrl(options.sourceUrl);

  const html = await fetchHtml(sourceUrl);
  const { seasonLabel, sourceUpdatedAt } = extractSeasonInfo(html);
  const rows = extractRows(html);
  if (rows.length === 0) {
    throw new Error('no rows parsed from TeamRankings table');
  }

  const csv = toCsv(rows, seasonLabel, sourceUpdatedAt);
  const summary = {
    output_path: outputPath,
    rows: rows.length,
    season: seasonLabel,
    source_updated_at: sourceUpdatedAt,
    source_url: sourceUrl,
  };

  if (stdout) {
    process.stdout.write(csv);
    return summary;
  }

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, csv, 'utf8');

  return summary;
}

async function main() {
  const { stdout } = parseArgs(process.argv);
  const summary = await refreshTeamRankingsNcaamFtCsv({ stdout });
  if (stdout) return;

  console.log(
    JSON.stringify(summary, null, 2),
  );
}

module.exports = {
  refreshTeamRankingsNcaamFtCsv,
};

if (require.main === module) {
  main().catch((error) => {
    console.error(`[Refresh:NCAAM-FT] ${error.message}`);
    process.exit(1);
  });
}
