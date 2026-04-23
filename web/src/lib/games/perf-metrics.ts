export type GamesRouteStage = 'query' | 'service' | 'transform';

export type GamesStageMetricKey =
  | 'games.query.ms'
  | 'games.service.ms'
  | 'games.transform.ms';

export type GamesStageMetricRecord = Record<GamesStageMetricKey, number>;

const STAGE_METRIC_KEYS: Record<GamesRouteStage, GamesStageMetricKey> = {
  query: 'games.query.ms',
  service: 'games.service.ms',
  transform: 'games.transform.ms',
};

export function createGamesStageMetrics(): GamesStageMetricRecord {
  return {
    'games.query.ms': 0,
    'games.service.ms': 0,
    'games.transform.ms': 0,
  };
}

export function normalizeGamesStageMetrics(
  metrics?: Partial<GamesStageMetricRecord> | null,
): GamesStageMetricRecord {
  return {
    'games.query.ms': Math.max(0, Math.round(metrics?.['games.query.ms'] ?? 0)),
    'games.service.ms': Math.max(
      0,
      Math.round(metrics?.['games.service.ms'] ?? 0),
    ),
    'games.transform.ms': Math.max(
      0,
      Math.round(metrics?.['games.transform.ms'] ?? 0),
    ),
  };
}

export function createGamesStageTracker(metrics: GamesStageMetricRecord) {
  let activeStage: GamesRouteStage | null = null;
  let activeStartedAt = 0;

  const finishActive = () => {
    if (!activeStage) return;
    const key = STAGE_METRIC_KEYS[activeStage];
    metrics[key] += Date.now() - activeStartedAt;
    activeStage = null;
    activeStartedAt = 0;
  };

  return {
    enter(stage: GamesRouteStage): void {
      finishActive();
      activeStage = stage;
      activeStartedAt = Date.now();
    },
    finish(): void {
      finishActive();
    },
  };
}
