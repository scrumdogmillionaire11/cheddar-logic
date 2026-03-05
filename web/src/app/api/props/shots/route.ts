import { NextRequest, NextResponse } from 'next/server';

const NUMBER_FIELDS = [
  'shotsPer60',
  'projectedToiMinutes',
  'opponentFactor',
  'paceFactor',
  'marketLine',
  'gamesObserved',
  'redistributionBoost',
] as const;

type ShotsRequest = {
  l5Shots?: number[];
  shotsPer60?: number;
  projectedToiMinutes?: number;
  opponentFactor?: number;
  paceFactor?: number;
  isHome?: boolean;
  marketLine?: number;
  role?: string;
  gamesObserved?: number;
  redistributionBoost?: number;
};

function isNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function parseNumberField(payload: Record<string, unknown>, key: string) {
  const raw = payload[key];
  if (raw == null) return undefined;
  const value = typeof raw === 'string' ? Number.parseFloat(raw) : raw;
  return isNumber(value) ? value : undefined;
}

function parseBoolean(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (['true', '1', 'yes'].includes(normalized)) return true;
    if (['false', '0', 'no'].includes(normalized)) return false;
  }
  return undefined;
}

function normalizeInput(payload: Record<string, unknown>): ShotsRequest {
  const normalized: ShotsRequest = {};

  const l5Raw = payload.l5Shots;
  if (Array.isArray(l5Raw)) {
    const parsed = l5Raw
      .map((value) =>
        typeof value === 'string' ? Number.parseFloat(value) : value,
      )
      .filter((value) => isNumber(value));
    if (parsed.length > 0) normalized.l5Shots = parsed;
  }

  for (const field of NUMBER_FIELDS) {
    const value = parseNumberField(payload, field);
    if (value !== undefined) {
      (normalized as Record<string, number>)[field] = value;
    }
  }

  const isHome = parseBoolean(payload.isHome);
  if (isHome !== undefined) normalized.isHome = isHome;

  if (typeof payload.role === 'string' && payload.role.trim().length > 0) {
    normalized.role = payload.role.trim();
  }

  return normalized;
}

function validateInput(input: ShotsRequest): string[] {
  const errors: string[] = [];

  if (
    !input.l5Shots &&
    !(isNumber(input.shotsPer60) && isNumber(input.projectedToiMinutes))
  ) {
    errors.push('Provide l5Shots or both shotsPer60 and projectedToiMinutes.');
  }

  if (input.l5Shots && input.l5Shots.some((value) => !isNumber(value))) {
    errors.push('l5Shots must contain numbers only.');
  }

  if (input.marketLine != null && !isNumber(input.marketLine)) {
    errors.push('marketLine must be a number.');
  }

  return errors;
}

export async function POST(request: NextRequest) {
  try {
    const payload = (await request.json()) as Record<string, unknown>;
    const normalized = normalizeInput(payload);
    const errors = validateInput(normalized);

    if (errors.length > 0) {
      return NextResponse.json(
        { success: false, errors },
        { status: 400, headers: { 'Content-Type': 'application/json' } },
      );
    }

    const { computeSogProjection } = await import('@cheddar-logic/models');
    const projection = computeSogProjection(normalized);

    return NextResponse.json(
      { success: true, data: projection, input: normalized },
      { headers: { 'Content-Type': 'application/json' } },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json(
      { success: false, error: message },
      { status: 500, headers: { 'Content-Type': 'application/json' } },
    );
  }
}
