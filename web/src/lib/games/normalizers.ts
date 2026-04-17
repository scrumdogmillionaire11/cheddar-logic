/**
 * Response field normalization helpers extracted from route.ts (WI-0621)
 * Pure utility functions — no DB dependencies.
 */

import { PASS_REASON_ALIAS_MAP } from '../game-card/transform/reason-codes';

// Local type alias matching route.ts Play interface — only the fields these
// normalizers return. Avoids importing the full Play type from the route file.
type MarketType =
  | 'MONEYLINE'
  | 'SPREAD'
  | 'TOTAL'
  | 'PUCKLINE'
  | 'TEAM_TOTAL'
  | 'FIRST_PERIOD'
  | 'FIRST_5_INNINGS'
  | 'PROP'
  | 'INFO';
type Tier = 'SUPER' | 'BEST' | 'WATCH' | null;
type Action = 'FIRE' | 'HOLD' | 'PASS';
type Status = 'FIRE' | 'WATCH' | 'PASS';
type Classification = 'BASE' | 'LEAN' | 'PASS';
type Prediction = 'HOME' | 'AWAY' | 'OVER' | 'UNDER' | 'NEUTRAL';
type GoalieStatus = 'CONFIRMED' | 'EXPECTED' | 'UNKNOWN';

export function parseJsonObject(value: unknown): Record<string, unknown> | null {
  if (!value) return null;
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === 'object'
        ? (parsed as Record<string, unknown>)
        : null;
    } catch {
      return null;
    }
  }
  return value && typeof value === 'object'
    ? (value as Record<string, unknown>)
    : null;
}

export function toFiniteNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function toObject(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object') return null;
  return value as Record<string, unknown>;
}

export function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }
  return undefined;
}

export function firstNumber(...values: unknown[]): number | undefined {
  for (const value of values) {
    if (typeof value === 'number' && Number.isFinite(value)) {
      return value;
    }
  }
  return undefined;
}

export function normalizeMarketType(value: unknown): MarketType | undefined {
  if (typeof value !== 'string') return undefined;
  const upper = value.trim().toUpperCase();

  if (
    upper === 'MONEYLINE' ||
    upper === 'SPREAD' ||
    upper === 'TOTAL' ||
    upper === 'PUCKLINE' ||
    upper === 'TEAM_TOTAL' ||
    upper === 'FIRST_PERIOD' ||
    upper === 'FIRST_5_INNINGS' ||
    upper === 'PROP' ||
    upper === 'INFO'
  ) {
    return upper as MarketType;
  }

  if (upper === 'PUCK_LINE') return 'PUCKLINE';
  if (upper === 'GAME_TOTAL') return 'TOTAL';
  if (upper === 'TEAMTOTAL') return 'TEAM_TOTAL';
  if (upper === 'FIRSTPERIOD') return 'FIRST_PERIOD';
  if (upper === 'DOUBLE_CHANCE' || upper === 'DOUBLECHANCE') {
    return 'MONEYLINE';
  }
  if (upper === 'DRAW_NO_BET' || upper === 'DRAWNOBET') {
    return 'MONEYLINE';
  }
  if (upper === 'ASIAN_HANDICAP') return 'SPREAD';
  return undefined;
}

export function normalizeKeyToken(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value.trim().toLowerCase().replace(/[\s-]+/g, '_');
}

export function normalizeTier(value: unknown): Tier {
  if (typeof value !== 'string') return null;
  const upper = value.trim().toUpperCase();
  if (upper === 'SUPER') return 'SUPER';
  if (upper === 'BEST' || upper === 'HOT') return 'BEST';
  if (upper === 'WATCH') return 'WATCH';
  return null;
}

export function normalizeAction(value: unknown): Action | undefined {
  if (typeof value !== 'string') return undefined;
  const upper = value.trim().toUpperCase();
  if (upper === 'FIRE' || upper === 'HOLD' || upper === 'PASS') {
    return upper as Action;
  }
  if (upper === 'WATCH') return 'HOLD';
  return undefined;
}

export function normalizeStatus(value: unknown): Status | undefined {
  if (typeof value !== 'string') return undefined;
  const upper = value.trim().toUpperCase();
  if (upper === 'FIRE' || upper === 'WATCH' || upper === 'PASS') {
    return upper as Status;
  }
  if (upper === 'HOLD') return 'WATCH';
  return undefined;
}

export function normalizeClassification(
  value: unknown,
): Classification | undefined {
  if (typeof value !== 'string') return undefined;
  const upper = value.trim().toUpperCase();
  if (upper === 'BASE' || upper === 'LEAN' || upper === 'PASS') {
    return upper as Classification;
  }
  return undefined;
}

export function normalizeSelectionSide(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const upper = value.trim().toUpperCase();
  if (
    upper === 'HOME' ||
    upper === 'AWAY' ||
    upper === 'OVER' ||
    upper === 'UNDER' ||
    upper === 'FAV' ||
    upper === 'DOG' ||
    upper === 'NONE' ||
    upper === 'NEUTRAL'
  ) {
    return upper;
  }
  return undefined;
}

export function normalizePrediction(value: unknown): Prediction | undefined {
  if (typeof value !== 'string') return undefined;
  const upper = value.trim().toUpperCase();
  if (
    upper === 'HOME' ||
    upper === 'AWAY' ||
    upper === 'OVER' ||
    upper === 'UNDER' ||
    upper === 'NEUTRAL'
  ) {
    return upper as Prediction;
  }
  if (upper.includes(' OVER ')) return 'OVER';
  if (upper.includes(' UNDER ')) return 'UNDER';
  return undefined;
}

export function normalizeGoalieStatus(
  value: unknown,
): GoalieStatus | undefined {
  // Status semantics:
  // CONFIRMED = official game-day roster (locked in)
  // EXPECTED = projected/likely but not yet confirmed (subject to change)
  // UNKNOWN = uncertain or unconfirmed
  //
  // Both CONFIRMED and EXPECTED must reach the UI so it can display
  // appropriate certainty levels. DO NOT collapse either to UNKNOWN.
  if (typeof value !== 'string') return undefined;
  const upper = value.trim().toUpperCase();
  if (upper === 'CONFIRMED') return 'CONFIRMED';
  if (upper === 'EXPECTED') return 'EXPECTED';
  if (upper === 'UNKNOWN') return 'UNKNOWN';
  return undefined;
}

export function normalizeSport(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const upper = value.trim().toUpperCase();
  return upper || undefined;
}

export function normalizePassReasonCode(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const code = value.trim().toUpperCase();
  if (!code) return null;
  if (code.startsWith('PASS_')) return code;

  return PASS_REASON_ALIAS_MAP[code] ?? code;
}

export function normalizePlayerNameKey(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const cleaned = value
    .trim()
    .toLowerCase()
    .replace(/[.'\u2019-]/g, ' ')
    .replace(/\b(jr|sr|ii|iii|iv|v)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned.length > 0 ? cleaned : null;
}

export function normalizeNumberArray(value: unknown): number[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const numbers = value.filter(
    (item) => typeof item === 'number' && Number.isFinite(item),
  ) as number[];
  return numbers.length > 0 ? numbers : undefined;
}

export function extractShotsFromRecentGames(value: unknown): number[] | undefined {
  if (!Array.isArray(value)) return undefined;

  const shots = value
    .map((item) => {
      if (!item || typeof item !== 'object') return undefined;
      const row = item as Record<string, unknown>;
      const direct = row.shots;
      if (typeof direct === 'number' && Number.isFinite(direct)) return direct;
      if (typeof direct === 'string') {
        const parsed = Number(direct);
        if (Number.isFinite(parsed)) return parsed;
      }
      return undefined;
    })
    .filter(
      (num): num is number => typeof num === 'number' && Number.isFinite(num),
    );

  return shots.length > 0 ? shots : undefined;
}
