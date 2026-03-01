import { useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { getDetailedProjections } from '@/lib/api';
import DecisionBrief from '@/components/DecisionBrief';
import CaptaincySection from '@/components/CaptaincySection';
import ChipDecision from '@/components/ChipDecision';
import RiskNote from '@/components/RiskNote';
import TransferSection from '@/components/TransferSection';
import SquadSection from '@/components/SquadSection';
import DataTransparency from '@/components/DataTransparency';

interface TransferRec {
  action: string;
  player_name: string;
  reason?: string;
  profile?: string;
  expected_pts?: number;
  priority?: number;
}

interface Captain {
  name: string;
  team?: string;
  position?: string;
  expected_pts?: number;
  rationale?: string;
  ownership_pct?: number;
}

interface ChipStrategy {
  decision: string;
  rationale?: string;
  timing?: string;
  best_gw?: number;
}

interface TransferPlan {
  out: string;
  in: string;
  hit_cost: number;
  net_cost: number;
  delta_pts_4gw?: number;
  delta_pts_6gw?: number;
  reason: string;
  confidence?: string;
}

interface TransferPlans {
  primary?: TransferPlan;
  secondary?: TransferPlan;
  additional?: TransferPlan[];
  no_transfer_reason?: string;
}

interface CaptainDelta {
  delta_pts?: number;
  delta_pts_4gw?: number;
}

interface SquadHealth {
  total_players: number;
  available: number;
  injured: number;
  doubtful: number;
  health_pct: number;
  critical_positions: string[];
}

interface BenchWarning {
  bench_count: number;
  bench_players: string[];
  avg_expected_pts: number;
  warning_message: string;
  suggestion: string;
  priority_signal?: string;
  has_urgent?: boolean;
}

interface AnalysisResults {
  team_name?: string;
  team_id?: number;
  current_gw?: number;
  risk_posture?: string;
  primary_decision?: string;
  confidence?: string;
  captain?: Captain;
  vice_captain?: Captain;
  captain_delta?: CaptainDelta;
  squad_health?: SquadHealth;
  transfer_recommendations?: TransferRec[];
  transfer_plans?: TransferPlans;
  bench_warning?: BenchWarning;
  chip_strategy?: ChipStrategy;
  chip_recommendation?: {
    recommendation?: string;
    rationale?: string;
    timing?: string;
    opportunity_cost?: {
      current_value: number;
      best_value: number;
      best_gw?: number;
      delta: number;
    } | null;
    best_gw?: number;
    current_window_name?: string;
    best_future_window_name?: string;
  };
  available_chips?: string[];
  active_chip?: string;
  starting_xi?: Array<{ name: string; expected_pts?: number; position?: string; team?: string }>;
  bench?: Array<{ name: string; expected_pts?: number; position?: string; team?: string }>;
  projected_xi?: Array<{ name: string; expected_pts?: number; position?: string; team?: string }>;
  projected_bench?: Array<{ name: string; expected_pts?: number; position?: string; team?: string }>;
  free_transfers?: number;
  generated_at?: string;
}

export default function Results() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [results, setResults] = useState<AnalysisResults | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const fetchResults = async () => {
      try {
        // First check sessionStorage for cached results
        const cachedData = sessionStorage.getItem(`analysis_${id}`);
        if (cachedData) {
          const data = JSON.parse(cachedData);
          if (data.status === 'completed' && data.results) {
            setResults(data.results);
            setLoading(false);
            return;
          }
        }
        
        // Try detailed projections endpoint first (new interactive API)
        try {
          const projections = await getDetailedProjections(id!);
          setResults(projections);
          setLoading(false);
          return;
        } catch (projErr) {
          console.log('Projections endpoint not available, falling back to standard results');
        }
        
        // Fallback to standard endpoint
        const response = await fetch(`/api/v1/analyze/${id}`);
        
        if (!response.ok) {
          if (response.status === 404) {
            setError('Analysis not found. Please run a new analysis.');
            return;
          }
          
          const errorText = await response.text();
          throw new Error(`HTTP ${response.status}: ${errorText}`);
        }
        
        const data = await response.json();
        
        if (data.status === 'completed' && data.results) {
          setResults(data.results);
        } else if (data.status === 'failed') {
          setError(data.error || 'Analysis failed');
        } else if (data.status === 'queued' || data.status === 'running') {
          setError('Analysis still processing');
        } else {
          setError('Analysis incomplete');
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Unknown error');
      } finally {
        setLoading(false);
      }
    };

    if (id) {
      fetchResults();
    }
  }, [id]);

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center p-6">
        <div className="max-w-reading w-full bg-surface-card p-8 border border-surface-elevated">
          <div className="flex items-center gap-3">
            <div className="h-4 w-4 border-2 border-hold border-t-transparent rounded-full animate-spin"></div>
            <p className="text-body text-sage-white">Loading results</p>
          </div>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="min-h-screen flex items-center justify-center p-6">
        <div className="max-w-reading w-full space-y-6">
          <div className="bg-surface-card border border-veto/40 p-6">
            <p className="text-body text-veto">{error}</p>
          </div>
          <button
            onClick={() => navigate('/')}
            className="w-full h-12 bg-hold text-bg-primary text-body font-medium hover:bg-hold/90 transition-colors"
          >
            Return to console
          </button>
        </div>
      </div>
    );
  }

  if (!results) {
    return null;
  }

  // ====================
  // CONTENT MAPPING LAYER
  // Backend data → Content contract
  // ====================

  // Helper to determine chip verdict first (needed for primary action)
  const getChipVerdict = (): 'NONE' | 'BB' | 'FH' | 'WC' | 'TC' => {
    const chipRec = results.chip_recommendation?.recommendation || results.chip_strategy?.decision || 'NONE';
    const upper = chipRec.toUpperCase();
    
    if (upper.includes('BB') || upper.includes('BENCH')) return 'BB';
    if (upper.includes('FH') || upper.includes('FREE')) return 'FH';
    if (upper.includes('WC') || upper.includes('WILD')) return 'WC';
    if (upper.includes('TC') || upper.includes('TRIPLE')) return 'TC';
    return 'NONE';
  };

  // 1. DECISION SUMMARY
  const getPrimaryAction = (): string => {
    // Check for actual chip recommendation first
    const chipVerdict = getChipVerdict();
    if (chipVerdict !== 'NONE') {
      return 'CHIP';
    }
    
    // Check for transfers
    if (results.transfer_recommendations && results.transfer_recommendations.length > 0) {
      return 'TRANSFER';
    }
    
    // Default to ROLL if no chips or transfers
    return 'ROLL';
  };

  const getConfidence = (): 'HIGH' | 'MED' | 'LOW' => {
    const conf = results.confidence?.toUpperCase() || 'MED';
    if (conf.includes('HIGH')) return 'HIGH';
    if (conf.includes('LOW')) return 'LOW';
    return 'MED';
  };

  const getJustification = (): string => {
    // Build a plain English justification from available data
    const chipVerdict = getChipVerdict();
    const action = getPrimaryAction();
    
    if (action === 'CHIP' && chipVerdict !== 'NONE') {
      return results.chip_strategy?.rationale || results.chip_recommendation?.rationale || `${chipVerdict} chip recommended for maximum value this gameweek.`;
    }
    
    if (action === 'TRANSFER' && results.transfer_recommendations && results.transfer_recommendations.length > 0) {
      const topTransfer = results.transfer_recommendations[0];
      return topTransfer.reason || 'Transfer improves squad structure and projected points.';
    }
    
    if (action === 'ROLL') {
      const transferCount = results.transfer_recommendations?.length || 0;
      if (transferCount === 0) {
        return 'No transfer clears hit thresholds; squad structure intact for next 4 GWs.';
      }
      return 'Available transfers do not meet value thresholds this gameweek.';
    }
    
    return 'Analysis complete based on current squad and fixtures.';
  };

  // 2. CAPTAINCY
  const getCaptainRationale = (captain: Captain): string => {
    if (captain.rationale) return captain.rationale;
    
    // Build rationale from available data
    const parts: string[] = [];
    if (captain.expected_pts) {
      parts.push(`Top projected points (${captain.expected_pts.toFixed(1)}pts)`);
    }
    if (captain.ownership_pct) {
      parts.push(`${captain.ownership_pct}% owned`);
    }
    return parts.join(' · ') || 'Highest expected points in starting XI';
  };

  // 3. CHIP EXPLANATION
  const getChipExplanation = (): string => {
    const verdict = getChipVerdict();
    
    if (verdict === 'NONE') {
      // MUST explain why no chip
      const rationale = results.chip_strategy?.rationale || results.chip_recommendation?.rationale;
      if (rationale) return rationale;
      
      // Default explanations
      return 'No chip usage maximizes value this gameweek; better windows ahead.';
    }
    
    return results.chip_strategy?.rationale || results.chip_recommendation?.rationale || `${verdict} recommended for maximum value.`;
  };

  // 4. RISK NOTE
  const getRiskStatement = (): string => {
    // Use squad health data if available
    const health = results.squad_health;
    if (health) {
      if (health.injured > 0 || health.doubtful > 0) {
        const issues = [];
        if (health.injured > 0) issues.push(`${health.injured} player${health.injured > 1 ? 's' : ''} injured`);
        if (health.doubtful > 0) issues.push(`${health.doubtful} doubtful`);

        if (health.health_pct < 75) {
          return `Squad availability concern: ${issues.join(', ')}. Consider bench strength for auto-subs.`;
        }
        return `Minor availability flag: ${issues.join(', ')}. Monitor news before deadline.`;
      }
    }

    // Fall back to risk posture based statement
    const riskPosture = results.risk_posture?.toLowerCase() || '';

    if (riskPosture.includes('aggressive')) {
      return 'Aggressive posture: higher variance expected, targeting upside over safety.';
    }

    if (riskPosture.includes('conservative')) {
      return 'Conservative posture: prioritizing safe floor over ceiling.';
    }

    // Default balanced
    return 'Balanced risk profile; core squad faces manageable upcoming fixtures.';
  };

  // 5. TRANSFERS (if applicable)
  // Now uses backend-calculated transfer_plans with metrics
  const getTransferPlans = () => {
    // Prefer backend-calculated transfer_plans (new format)
    if (results.transfer_plans) {
      const plans = results.transfer_plans;

      if (plans.no_transfer_reason && !plans.primary) {
        return {
          noTransferReason: plans.no_transfer_reason
        };
      }

      // Map additional plans if present
      const additionalPlans = plans.additional?.map((p: TransferPlan) => ({
        out: p.out,
        in: p.in,
        hitCost: p.hit_cost,
        netCost: p.net_cost,
        deltaPoints4GW: p.delta_pts_4gw,
        deltaPoints6GW: p.delta_pts_6gw,
        reason: p.reason
      }));

      return {
        primaryPlan: plans.primary ? {
          out: plans.primary.out,
          in: plans.primary.in,
          hitCost: plans.primary.hit_cost,
          netCost: plans.primary.net_cost,
          deltaPoints4GW: plans.primary.delta_pts_4gw,
          deltaPoints6GW: plans.primary.delta_pts_6gw,
          reason: plans.primary.reason
        } : undefined,
        secondaryPlan: plans.secondary ? {
          out: plans.secondary.out,
          in: plans.secondary.in,
          hitCost: plans.secondary.hit_cost,
          netCost: plans.secondary.net_cost,
          deltaPoints4GW: plans.secondary.delta_pts_4gw,
          deltaPoints6GW: plans.secondary.delta_pts_6gw,
          reason: plans.secondary.reason
        } : undefined,
        additionalPlans,
        noTransferReason: plans.no_transfer_reason
      };
    }

    // Fallback to old format (for backward compatibility)
    const transfers = results.transfer_recommendations || [];

    if (transfers.length === 0) {
      return {
        noTransferReason: 'No transfer clears value thresholds this GW.'
      };
    }

    // Map transfers to primary/secondary plans (legacy path)
    const outTransfers = transfers.filter(t => t.action === 'OUT');
    const inTransfers = transfers.filter(t => t.action === 'IN');

    if (outTransfers.length > 0 && inTransfers.length > 0) {
      return {
        primaryPlan: {
          out: outTransfers[0].player_name,
          in: inTransfers[0].player_name,
          hitCost: 0,
          netCost: 0,
          deltaPoints4GW: inTransfers[0].expected_pts,
          reason: inTransfers[0].reason || 'Improves squad structure and points projection'
        },
        secondaryPlan: outTransfers.length > 1 && inTransfers.length > 1 ? {
          out: outTransfers[1].player_name,
          in: inTransfers[1].player_name,
          hitCost: 0,
          netCost: 0,
          reason: inTransfers[1].reason || 'Lower risk alternative'
        } : undefined
      };
    }

    return {
      noTransferReason: 'No transfer clears value thresholds this GW.'
    };
  };

  // ====================
  // RENDER: Content Contract Order
  // ====================

  const primaryAction = getPrimaryAction();
  const confidence = getConfidence();
  const justification = getJustification();
  const chipVerdict = getChipVerdict();
  const chipExplanation = getChipExplanation();
  const riskStatement = getRiskStatement();
  const transferPlans = getTransferPlans();

  return (
    <div className="min-h-screen bg-surface-primary">
      {/* HEADER - Minimal navigation */}
      <header className="border-b border-surface-elevated py-6">
        <div className="max-w-reading mx-auto px-6 flex justify-between items-center">
          <div className="text-body-sm text-sage-muted uppercase tracking-wider">
            FPL Sage
          </div>
          <button
            onClick={() => navigate('/')}
            className="text-body-sm text-sage-muted hover:text-sage-white transition-colors"
          >
            New analysis
          </button>
        </div>
      </header>

      {/* MAIN CONTENT - Centered reading column */}
      <main className="max-w-reading mx-auto px-6 py-12 space-y-6">
        
        {/* A. DECISION SUMMARY - Always visible, no scrolling */}
        <DecisionBrief
          primaryAction={primaryAction}
          confidence={confidence}
          justification={justification}
          gameweek={results.current_gw}
        />

        {/* B. CAPTAINCY - Always visible */}
        {results.captain && results.vice_captain && (
          <CaptaincySection
            captain={{
              ...results.captain,
              rationale: getCaptainRationale(results.captain)
            }}
            viceCaptain={{
              ...results.vice_captain,
              rationale: getCaptainRationale(results.vice_captain)
            }}
            delta={results.captain_delta}
          />
        )}

        {/* C. STARTING XI - Show optimized lineup with toggle */}
        {results.starting_xi && results.starting_xi.length > 0 && (
          <SquadSection
            title="Starting XI"
            currentSquad={results.starting_xi}
            projectedSquad={results.projected_xi}
            hasTransfers={!!(results.transfer_plans?.primary || results.transfer_plans?.secondary)}
          />
        )}

        {/* D. BENCH - Show bench order with toggle */}
        {results.bench && results.bench.length > 0 && (
          <SquadSection
            title="Bench Order"
            currentSquad={results.bench}
            projectedSquad={results.projected_bench}
            hasTransfers={!!(results.transfer_plans?.primary || results.transfer_plans?.secondary)}
          />
        )}

        {/* E. TRANSFERS - Conditional, collapsed by default */}
        <TransferSection 
          {...transferPlans} 
          freeTransfers={results.free_transfers}
          benchWarning={results.bench_warning}
        />

        {/* F. CHIP DECISION - Always visible */}
        <ChipDecision
          chipVerdict={chipVerdict}
          explanation={chipExplanation}
          availableChips={results.available_chips}
          opportunityCost={results.chip_recommendation?.opportunity_cost || null}
          bestGw={results.chip_recommendation?.best_gw}
          currentWindowName={results.chip_recommendation?.current_window_name}
          bestFutureWindowName={results.chip_recommendation?.best_future_window_name}
        />

        {/* G. RISK NOTE - Always visible */}
        <RiskNote riskStatement={riskStatement} squadHealth={results.squad_health} />

      </main>

      {/* FOOTER - Data transparency */}
      <footer className="border-t border-surface-elevated mt-16">
        <div className="max-w-reading mx-auto px-6 py-8">
          <DataTransparency
            projectionWindow={`GW${results.current_gw || '?'} to GW${(results.current_gw || 0) + 5}`}
            updatedAt={results.generated_at}
            warnings={[]}
          />
        </div>
      </footer>
    </div>
  );
}
