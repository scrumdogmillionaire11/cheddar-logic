/**
 * FPL Sage API Client
 * Communicates with the FastAPI backend for FPL analysis
 */

const FPL_API_BASE_URL = process.env.NEXT_PUBLIC_FPL_API_URL || '/api/v1';

export interface AnalyzeRequest {
  team_id: number;
  gameweek?: number;
}

export interface AnalyzeResponse {
  analysis_id: string;
  status: string;
  estimated_duration: number;
}

export interface PlayerData {
  name: string;
  team: string;
  position: string;
  cost?: number;
  ownership_pct?: number;
  expected_points?: number;
  injury_status?: string;
  is_captain: boolean;
  is_vice_captain: boolean;
  in_starting_11: boolean;
}

export interface WeaknessData {
  type: string;
  severity: string;
  player: string;
  detail: string;
  action: string;
}

export interface TransferTarget {
  name: string;
  team: string;
  position: string;
  cost?: number;
  expected_points?: number;
  priority?: string;
  reason?: string;
  injury_status?: string;
}

export interface ChipAdvice {
  chip: string;
  recommendation: string;
  reason: string;
  timing?: string;
}

export interface DashboardData {
  gameweek: {
    current: number;
    season: string;
    deadline?: string;
  };
  my_team?: {
    starting_11: PlayerData[];
    bench: PlayerData[];
    value?: number;
    bank?: number;
    transfers_available?: number;
  };
  weaknesses: WeaknessData[];
  transfer_targets: TransferTarget[];
  chip_advice: ChipAdvice[];
  captain_advice?: {
    captain: string;
    vice_captain: string;
    reasoning: string;
  };
  decision_summary?: {
    decision: string;
    reasoning: string;
    status: string;
    confidence: string;
  };
  metadata: {
    analysis_id: string;
    generated_at: string;
    analysis_timestamp: string;
    run_id: string;
  };
}

export interface AnalysisStatusResponse {
  status: 'queued' | 'running' | 'analyzing' | 'complete' | 'failed';
  progress?: number;
  phase?: string;
  error?: string;
  results?: Record<string, unknown>;
}

/**
 * Trigger a new FPL analysis
 */
export async function triggerAnalysis(request: AnalyzeRequest): Promise<AnalyzeResponse> {
  const response = await fetch(`${FPL_API_BASE_URL}/analyze`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(request),
  });

  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.detail?.detail || error.detail || 'Analysis failed to start');
  }

  return response.json();
}

/**
 * Check analysis status
 */
export async function getAnalysisStatus(analysisId: string): Promise<AnalysisStatusResponse> {
  const response = await fetch(`${FPL_API_BASE_URL}/analyze/${analysisId}/status`);

  if (!response.ok) {
    throw new Error(`Failed to fetch analysis status: ${response.statusText}`);
  }

  return response.json();
}

/**
 * Get dashboard data for a completed analysis
 */
export async function getDashboardData(analysisId: string): Promise<DashboardData> {
  const response = await fetch(`${FPL_API_BASE_URL}/dashboard/${analysisId}`);

  if (!response.ok) {
    if (response.status === 202) {
      throw new Error('STILL_RUNNING');
    }
    const error = await response.json();
    throw new Error(error.detail || 'Failed to fetch dashboard data');
  }

  return response.json();
}

/**
 * Poll for analysis completion and return dashboard data
 */
export async function pollForDashboard(
  analysisId: string,
  maxAttempts = 60,
  intervalMs = 2000
): Promise<DashboardData> {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      const data = await getDashboardData(analysisId);
      return data;
    } catch (error) {
      if (error instanceof Error && error.message === 'STILL_RUNNING') {
        // Still running, wait and try again
        await new Promise(resolve => setTimeout(resolve, intervalMs));
        continue;
      }
      throw error;
    }
  }

  throw new Error('Analysis timed out. Please try again.');
}
