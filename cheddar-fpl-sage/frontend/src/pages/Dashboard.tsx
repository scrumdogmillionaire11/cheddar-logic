import { useState, useCallback } from 'react';
import { 
  createAnalysis, 
  getDetailedProjections, 
  type InjuryOverride,
  type AnalysisResults 
} from '@/lib/api';
import RiskPostureSelector, { type RiskPosture } from '@/components/RiskPostureSelectorCompact';
import ChipSelector, { type ChipStatus } from '@/components/ChipSelectorCompact';
import InjuryOverrideSelector from '@/components/InjuryOverrideSelectorCompact';
import FreeTransfersSelector from '@/components/FreeTransfersSelectorCompact';
import DecisionBrief from '@/components/DecisionBrief';
import CaptaincySection from '@/components/CaptaincySection';
import ChipDecision from '@/components/ChipDecision';
import TransferSection from '@/components/TransferSection';
import TeamInfo from '@/components/TeamInfo';
import CurrentSquad from '@/components/CurrentSquad';

const RISK_POSTURE_CONFIG = {
  conservative: {
    label: 'Conservative',
    color: '#22c55e',
    bg: 'rgba(34,197,94,0.08)',
    border: 'rgba(34,197,94,0.25)',
    icon: '🛡️',
    tagline: 'Protect your rank. Don\'t chase.',
    thresholds: {
      transferGainFloor: 2.5,
      hitNetFloor: 6,
      maxHitsPerGW: 0,
      chipDeployBoost: 15,
      captainDiffMaxOwnership: 5,
      bbMinBenchXPts: 12,
      tcRequiresDGW: true,
    },
    behaviors: [
      { category: 'Transfers', rule: 'Only transfer players with clear OUT/injury status. Gain threshold ≥ 2.5 pts over 3 GWs.' },
      { category: 'Hits', rule: 'No hits unless 3+ starters are OUT. Requires 6pt gain minimum.' },
      { category: 'Captain', rule: 'Always pick highest-ownership premium. Differentials only if ownership < 5% AND xPts ≥ 8.' },
      { category: 'Chips', rule: 'Raise chip deploy threshold by +15 pts. BB only in DGW with 12+ bench xPts.' },
      { category: 'Bench', rule: 'Prioritize reliable bench coverage over speculative starters.' },
    ],
  },
  balanced: {
    label: 'Balanced',
    color: '#f59e0b',
    bg: 'rgba(245,158,11,0.08)',
    border: 'rgba(245,158,11,0.25)',
    icon: '⚖️',
    tagline: 'Optimal EV. Standard thresholds.',
    thresholds: {
      transferGainFloor: 1.5,
      hitNetFloor: 8,
      maxHitsPerGW: 1,
      chipDeployBoost: 0,
      captainDiffMaxOwnership: 25,
      bbMinBenchXPts: 10,
      tcRequiresDGW: false,
    },
    behaviors: [
      { category: 'Transfers', rule: 'Transfer when gain ≥ 1.5 pts projected over next 3 GWs.' },
      { category: 'Hits', rule: '1 hit acceptable if net gain ≥ 8 pts. 2 hits only in extreme emergencies.' },
      { category: 'Captain', rule: 'Best projected captain. Mix ownership and differential. Max 25% differential risk.' },
      { category: 'Chips', rule: 'Standard thresholds apply (score ≥ 70 = DEPLOY).' },
      { category: 'Bench', rule: 'Budget for 1 premium bench player near DGW window.' },
    ],
  },
  aggressive: {
    label: 'Aggressive',
    color: '#ef4444',
    bg: 'rgba(239,68,68,0.08)',
    border: 'rgba(239,68,68,0.25)',
    icon: '⚡',
    tagline: 'Chase the ceiling. High variance, high upside.',
    thresholds: {
      transferGainFloor: 1,
      hitNetFloor: 5,
      maxHitsPerGW: 2,
      chipDeployBoost: -10,
      captainDiffMaxOwnership: 15,
      bbMinBenchXPts: 8,
      tcRequiresDGW: false,
    },
    behaviors: [
      { category: 'Transfers', rule: 'Transfer on form + fixture alone. Gain threshold drops to 1 pt if differential.' },
      { category: 'Hits', rule: 'Up to 2 hits per GW if squad misaligned. 4pt hit worth it for 5+ pts EV.' },
      { category: 'Captain', rule: 'Target differentials < 15% ownership if xPts ≥ 7.5. Avoid template captain.' },
      { category: 'Chips', rule: 'Lower threshold by -10 pts. TC on single game if xPts ≥ 10.' },
      { category: 'Bench', rule: 'Deprioritize bench. Accept weakness for starting XI quality.' },
    ],
  },
};

interface FplContextState {
  freeTransfers: number;
  chips: string[];
  riskPosture: RiskPosture;
  benchPoints: number;
  injuries: Array<{ player: string; status: 'FIT' | 'DOUBTFUL' | 'OUT'; chance: number }>;
  transferIntent: Array<{ out: string; in: string; reason: string; priority: 'URGENT' | 'PLANNED' | 'CONSIDERING' }>;
  notes: string;
  planningNotes: string;
  rankChasing: boolean;
}

export default function Dashboard() {
  // Team ID and FPL context state
  const [teamId, setTeamId] = useState('711511');
  const [fplCtx, setFplCtx] = useState<FplContextState>({
    freeTransfers: 1,
    chips: [],
    riskPosture: 'balanced',
    benchPoints: 0,
    injuries: [],
    transferIntent: [],
    notes: '',
    planningNotes: '',
    rankChasing: false,
  });

  // Analysis state
  const [results, setResults] = useState<AnalysisResults | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // UI state
  const [showReasoning, setShowReasoning] = useState(true);
  const [showResults, setShowResults] = useState(false);
  const [expandedBehaviors, setExpandedBehaviors] = useState(false);

  const postureConfig = RISK_POSTURE_CONFIG[fplCtx.riskPosture];

  const chipStatusFromArray = (chips: string[]): ChipStatus => ({
    wildcard: chips.includes('wildcard'),
    benchBoost: chips.includes('bench_boost'),
    tripleCaptain: chips.includes('triple_captain'),
    freeHit: chips.includes('free_hit'),
  });

  const arrayFromChipStatus = (chips: ChipStatus | null): string[] => {
    if (!chips) return [];
    return [
      chips.wildcard ? 'wildcard' : null,
      chips.benchBoost ? 'bench_boost' : null,
      chips.tripleCaptain ? 'triple_captain' : null,
      chips.freeHit ? 'free_hit' : null,
    ].filter(Boolean) as string[];
  };

  const injuriesToApi = (injuries: FplContextState['injuries']): InjuryOverride[] =>
    injuries.map((inj) => ({
      player_name: inj.player,
      status: inj.status,
      chance: inj.chance,
    }));

  const injuriesFromApi = (injuries: InjuryOverride[]): FplContextState['injuries'] =>
    injuries.map((inj) => ({
      player: inj.player_name,
      status: inj.status,
      chance: inj.chance || 0,
    }));

  // Generate local reasoning before analysis
  const generateLocalReasoning = useCallback(() => {
    const factors = [];
    const decisions = [];

    // Transfer logic
    if (fplCtx.freeTransfers === 0) {
      factors.push({
        signal: 'Transfer bank',
        value: 'EMPTY',
        note: 'Any move costs 4pts',
      });
      if (fplCtx.riskPosture === 'conservative') {
        decisions.push({
          action: 'HOLD',
          detail: 'Conservative mode: no hits. Hold until free transfer regenerates.',
        });
      } else if (fplCtx.riskPosture === 'balanced') {
        decisions.push({
          action: 'HOLD',
          detail: 'No free transfers. Only transfer if gain > 8pts net of hit cost.',
        });
      } else {
        decisions.push({
          action: 'CONSIDER HIT',
          detail: 'Aggressive mode: 1 hit acceptable if squad misaligned and EV gain ≥ 5pts.',
        });
      }
    } else {
      factors.push({
        signal: 'Free transfers',
        value: fplCtx.freeTransfers,
        note: `${fplCtx.freeTransfers > 1 ? 'Can chain moves' : '1 surgical transfer'}`,
      });
    }

    // Chip availability
    const availableChips = fplCtx.chips;

    if (availableChips.length > 0) {
      factors.push({
        signal: 'Available chips',
        value: availableChips.length,
        note: availableChips.join(', '),
      });
    }

    // Bench points
    if (fplCtx.benchPoints > 0) {
      const benchBehavior =
        fplCtx.benchPoints >= 12
          ? 'HIGH bench score — BB deserves serious consideration'
          : fplCtx.benchPoints >= 8
          ? 'Decent bench return. Monitor for DGW'
          : 'Low bench score. Rebuild depth first';
      factors.push({
        signal: 'Bench pts (last GW)',
        value: fplCtx.benchPoints,
        note: benchBehavior,
      });
    }

    // Injury overrides
    const outPlayers = fplCtx.injuries.filter((i) => i.status === 'OUT');
    if (outPlayers.length > 0) {
      factors.push({
        signal: 'Injury overrides',
        value: outPlayers.length,
        note: `${outPlayers.length} player${outPlayers.length > 1 ? 's' : ''} confirmed OUT`,
      });
      decisions.push({
        action: 'URGENT TRANSFER',
        detail: `${outPlayers.length} injury override${outPlayers.length > 1 ? 's' : ''} active. Factor into transfer priority.`,
      });
    }

    return { factors, decisions };
  }, [fplCtx]);

  const reasoning = generateLocalReasoning();

  // Run full analysis
  const runAnalysis = async () => {
    setLoading(true);
    setError(null);
    setShowResults(false);

    const id = parseInt(teamId.trim());
    if (isNaN(id) || id <= 0) {
      setError('Invalid team ID');
      setLoading(false);
      return;
    }

    try {
      const availableChips = fplCtx.chips.length > 0 ? fplCtx.chips : undefined;

      const postureThresholds = postureConfig.thresholds;

      const analysis = await createAnalysis({
        team_id: id,
        available_chips: availableChips,
        free_transfers: fplCtx.freeTransfers,
        injury_overrides: fplCtx.injuries.length > 0 ? injuriesToApi(fplCtx.injuries) : undefined,
        risk_posture: fplCtx.riskPosture,
        thresholds: postureThresholds,
      });

      if (analysis.status === 'completed' && analysis.results) {
        setResults(analysis.results);
        setShowResults(true);
      } else {
        // Poll for results
        pollForResults(analysis.analysis_id);
      }
    } catch (err: unknown) {
      console.error('Analysis error:', err);
      setError(err instanceof Error ? err.message : 'Analysis failed');
    } finally {
      setLoading(false);
    }
  };

  const pollForResults = async (id: string) => {
    const maxAttempts = 60;
    let attempts = 0;

    const poll = async () => {
      if (attempts >= maxAttempts) {
        setError('Analysis timeout - please try again');
        return;
      }

      try {
        const projections = await getDetailedProjections(id);
        setResults(projections);
        setShowResults(true);
      } catch {
        attempts++;
        setTimeout(poll, 2000);
      }
    };

    poll();
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-950 via-slate-900 to-slate-950 text-slate-100 p-6">
      <div className="max-w-7xl mx-auto space-y-6">
        {/* Header */}
        <div className="flex justify-between items-end">
          <div>
            <div className="text-xs text-slate-500 uppercase tracking-widest mb-2">
              ◆ FPL SAGE 2.0 ◆ DECISION ENGINE
            </div>
            <h1 className="text-3xl font-bold text-slate-100">Dashboard</h1>
            <div className="mt-1 text-sm text-slate-400">
              Real-time context • Live reasoning • Instant updates
            </div>
          </div>
          <button
            onClick={() => setShowReasoning(!showReasoning)}
            className="px-4 py-2 rounded-lg text-sm font-semibold transition-all"
            style={{
              background: showReasoning ? 'rgba(168,85,247,0.12)' : 'rgba(255,255,255,0.03)',
              border: `1px solid ${showReasoning ? 'rgba(168,85,247,0.4)' : 'rgba(255,255,255,0.08)'}`,
              color: showReasoning ? '#a855f7' : '#64748b',
            }}
          >
            {showReasoning ? '▲ Hide Reasoning' : '▼ Show Reasoning'}
          </button>
        </div>

        {/* Context Editor */}
        <div
          className="rounded-xl p-6 backdrop-blur-xl"
          style={{
            background: 'rgba(10,14,26,0.75)',
            border: '1px solid rgba(168,85,247,0.2)',
          }}
        >
          <div className="flex items-center gap-2 mb-6">
            <div className="w-2 h-2 rounded-full bg-purple-500 shadow-lg shadow-purple-500/50 animate-pulse" />
            <div className="text-xs text-slate-500 uppercase tracking-wider font-bold">
              Manual Context
            </div>
            <span className="text-xs text-slate-600">— what neither API provides</span>
          </div>

          <div className="grid grid-cols-3 gap-8">
            {/* Column 1: Basic inputs */}
            <div className="space-y-6">
              {/* Team ID */}
              <div>
                <label className="block text-xs text-slate-500 uppercase tracking-wider font-bold mb-2">
                  Team ID
                </label>
                <input
                  type="text"
                  value={teamId}
                  onChange={(e) => setTeamId(e.target.value)}
                  className="w-full px-3 py-2 rounded-lg text-sm bg-white/5 border border-white/10 text-slate-100 outline-none focus:border-purple-500/50 transition-colors"
                  placeholder="Enter FPL Team ID"
                />
              </div>

              {/* Free Transfers */}
              <div>
                <label className="block text-xs text-slate-500 uppercase tracking-wider font-bold mb-2">
                  Free Transfers
                </label>
                <FreeTransfersSelector
                  value={fplCtx.freeTransfers}
                  onChange={(val) => setFplCtx({ ...fplCtx, freeTransfers: val })}
                />
              </div>

              {/* Bench Points */}
              <div>
                <label className="block text-xs text-slate-500 uppercase tracking-wider font-bold mb-2">
                  Bench Pts — Last GW
                </label>
                <div className="flex items-center gap-3">
                  <input
                    type="range"
                    min={0}
                    max={30}
                    value={fplCtx.benchPoints}
                    onChange={(e) => setFplCtx({ ...fplCtx, benchPoints: +e.target.value })}
                    className="flex-1"
                    style={{ accentColor: '#a855f7' }}
                  />
                  <span className="text-lg font-bold text-slate-100 w-8 text-right">
                    {fplCtx.benchPoints}
                  </span>
                </div>
                <div className="text-xs text-slate-500 mt-1">
                    {fplCtx.benchPoints >= 12
                    ? '🟢 Strong — BB deserves consideration'
                      : fplCtx.benchPoints >= 8
                    ? '🟡 Decent — build toward DGW'
                    : '🔴 Weak — rebuild depth first'}
                </div>
              </div>

              {/* Notes */}
              <div>
                <label className="block text-xs text-slate-500 uppercase tracking-wider font-bold mb-2">
                  Strategy Notes
                </label>
                <textarea
                  value={fplCtx.planningNotes}
                  onChange={(e) => setFplCtx({ ...fplCtx, planningNotes: e.target.value, notes: e.target.value })}
                  rows={3}
                  className="w-full px-3 py-2 rounded-lg text-sm bg-white/5 border border-white/10 text-slate-100 outline-none focus:border-purple-500/50 transition-colors resize-none"
                  placeholder="e.g. Holding WC for GW32 DGW setup"
                />
              </div>
            </div>

            {/* Column 2: Risk Posture */}
            <div>
              <label className="block text-xs text-slate-500 uppercase tracking-wider font-bold mb-2">
                Risk Posture
              </label>
              <RiskPostureSelector
                  value={fplCtx.riskPosture}
                  onChange={(val) => setFplCtx({ ...fplCtx, riskPosture: val })}
              />

              {/* Expanded Behaviors */}
              <button
                onClick={() => setExpandedBehaviors(!expandedBehaviors)}
                className="mt-4 text-xs text-slate-500 hover:text-slate-400 transition-colors"
              >
                {expandedBehaviors ? '▲ Hide' : '▼ Show'} posture rules
              </button>

              {expandedBehaviors && (
                <div
                  className="mt-3 p-4 rounded-lg space-y-2"
                  style={{
                    background: postureConfig.bg,
                    border: `1px solid ${postureConfig.border}`,
                  }}
                >
                  {postureConfig.behaviors.map((b, i) => (
                    <div key={i} className="flex gap-2 items-start">
                      <span
                        className="text-[9px] font-bold px-1.5 py-0.5 rounded shrink-0"
                        style={{
                          color: postureConfig.color,
                          background: postureConfig.bg,
                          border: `1px solid ${postureConfig.border}`,
                        }}
                      >
                        {b.category.toUpperCase()}
                      </span>
                      <span className="text-xs text-slate-400 leading-relaxed">{b.rule}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Column 3: Chips + Injuries */}
            <div className="space-y-6">
              {/* Chips */}
              <div>
                <label className="block text-xs text-slate-500 uppercase tracking-wider font-bold mb-2">
                  Available Chips
                </label>
                <ChipSelector
                  value={chipStatusFromArray(fplCtx.chips)}
                  onChange={(val) => setFplCtx({ ...fplCtx, chips: arrayFromChipStatus(val) })}
                />
              </div>

              {/* Injury Overrides */}
              <div>
                <label className="block text-xs text-slate-500 uppercase tracking-wider font-bold mb-2">
                  Injury Overrides
                </label>
                <InjuryOverrideSelector
                  value={injuriesToApi(fplCtx.injuries)}
                  onChange={(val) => setFplCtx({ ...fplCtx, injuries: injuriesFromApi(val) })}
                />
              </div>
            </div>
          </div>

          {/* Analyze Button */}
          <div className="mt-8 pt-6 border-t border-white/5">
            <button
              onClick={runAnalysis}
              disabled={loading}
              className="w-full py-3 px-6 rounded-lg font-semibold text-sm transition-all disabled:opacity-50 disabled:cursor-not-allowed"
              style={{
                background: loading
                  ? 'rgba(168,85,247,0.2)'
                  : 'linear-gradient(135deg, #a855f7 0%, #ec4899 100%)',
                color: '#fff',
                boxShadow: loading ? 'none' : '0 4px 20px rgba(168,85,247,0.3)',
              }}
            >
              {loading ? (
                <span className="flex items-center justify-center gap-2">
                  <span className="inline-block w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                  Running Analysis...
                </span>
              ) : (
                'Run Full Analysis'
              )}
            </button>
          </div>
        </div>

        {/* Live Reasoning Panel */}
        {showReasoning && (
          <div
            className="rounded-xl p-6 backdrop-blur-xl"
            style={{
              background: 'rgba(10,14,26,0.75)',
              border: `1px solid ${postureConfig.border}`,
            }}
          >
            {/* Summary Bar */}
            <div
              className="flex justify-between items-start p-4 rounded-lg mb-6"
              style={{
                background: `${postureConfig.color}10`,
                border: `1px solid ${postureConfig.border}`,
                borderLeft: `4px solid ${postureConfig.color}`,
              }}
            >
              <div className="flex-1">
                <div
                  className="text-sm font-bold mb-2"
                  style={{ color: postureConfig.color, letterSpacing: '0.02em' }}
                >
                  CONTEXT EVALUATION
                </div>
                <div className="space-y-1 text-sm text-slate-400">
                  {reasoning.decisions.map((d, i) => (
                    <div key={i}>
                      {i === 0 ? '→ ' : '· '}
                      {d.detail}
                    </div>
                  ))}
                  <div>· {postureConfig.tagline}</div>
                </div>
              </div>
              <div className="text-right shrink-0 ml-6">
                <div className="text-[9px] text-slate-600 uppercase tracking-wider mb-1">
                  Posture
                </div>
                <div className="flex items-center gap-2" style={{ color: postureConfig.color }}>
                  <span className="text-xl">{postureConfig.icon}</span>
                  <span className="text-base font-bold">{postureConfig.label}</span>
                </div>
              </div>
            </div>

            {/* Signals Grid */}
            <div className="grid grid-cols-2 gap-6">
              {/* Input Signals */}
              <div>
                <div className="text-xs text-slate-500 uppercase tracking-wider font-bold mb-3">
                  Input Signals
                </div>
                <div className="space-y-2">
                  {reasoning.factors.map((f, i) => (
                    <div
                      key={i}
                      className="flex gap-3 items-start p-3 rounded-lg bg-white/5 border border-white/5"
                    >
                      <span className="text-xs text-slate-500 min-w-[100px] shrink-0">{f.signal}</span>
                      <span className="text-xs font-bold text-slate-300 shrink-0">{f.value}</span>
                      <span className="text-xs text-slate-500 leading-relaxed">{f.note}</span>
                    </div>
                  ))}
                </div>
              </div>

              {/* Derived Decisions */}
              <div>
                <div className="text-xs text-slate-500 uppercase tracking-wider font-bold mb-3">
                  Derived Decisions
                </div>
                <div className="space-y-2">
                  {reasoning.decisions.map((d, i) => {
                    const actionColor = d.action.includes('HOLD')
                      ? '#64748b'
                      : d.action.includes('URGENT')
                      ? '#ef4444'
                      : d.action.includes('HIT')
                      ? '#f59e0b'
                      : '#22c55e';
                    return (
                      <div
                        key={i}
                        className="p-3 rounded-lg bg-white/5"
                        style={{ borderLeft: `3px solid ${actionColor}` }}
                      >
                        <div
                          className="text-[10px] font-bold mb-1 uppercase tracking-wider"
                          style={{ color: actionColor }}
                        >
                          {d.action}
                        </div>
                        <div className="text-xs text-slate-400 leading-relaxed">{d.detail}</div>
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Error Display */}
        {error && (
          <div className="rounded-xl p-4 bg-red-500/10 border border-red-500/30 text-red-400">
            {error}
          </div>
        )}

        {/* Results Display */}
        {showResults && results && (
          <div className="space-y-6">
            <div className="text-xs text-slate-500 uppercase tracking-widest mb-2">
              ◆ ANALYSIS RESULTS
            </div>

            {/* Team Info - Value, Bank, Rank */}
            <TeamInfo
              teamName={results.team_name}
              managerName={results.manager_name}
              teamValue={results.team_value}
              bank={results.bank}
              overallRank={results.overall_rank}
              overallPoints={results.overall_points}
            />

            {results.primary_decision && (
              <DecisionBrief
                primaryAction={results.primary_decision}
                confidence={(results.confidence as 'HIGH' | 'MED' | 'LOW') || 'MED'}
                justification={results.primary_decision}
                gameweek={results.current_gw}
              />
            )}

            {results.captain && (
              <CaptaincySection
                captain={results.captain}
                viceCaptain={results.vice_captain || { name: 'TBD' }}
              />
            )}

            {(results.chip_strategy || results.chip_recommendation) && (
              <ChipDecision
                chipVerdict={results.chip_verdict || 'NONE'}
                explanation={results.chip_explanation || 'No chip recommendation available'}
                availableChips={results.available_chips}
              />
            )}

            {(results.transfer_recommendations || results.transfer_plans) && (() => {
              // Transfer recommendations come in pairs: [OUT action, IN action]
              // Find the OUT and IN actions for the primary transfer
              const outAction = results.transfer_recommendations?.find(t => t.action === 'OUT');
              const inAction = results.transfer_recommendations?.find(t => t.action === 'IN');
              
              return (
                <TransferSection
                  primaryPlan={outAction && inAction ? {
                    out: outAction.player_name || '',
                    in: inAction.player_name || '',
                    hitCost: 0,
                    netCost: 0,
                    reason: outAction.reason || inAction.reason || '',
                  } : undefined}
                  freeTransfers={results.free_transfers}
                  noTransferReason={!results.transfer_recommendations?.length ? 'No transfers needed this week' : undefined}
                />
              );
            })()}

            {/* Current Squad - Starting XI and Bench */}
            {(results.starting_xi || results.bench) && (
              <CurrentSquad
                startingXI={results.starting_xi}
                bench={results.bench}
                title="Current Squad"
              />
            )}

            {/* Projected Squad after Transfers */}
            {results.projected_xi && results.transfer_recommendations && results.transfer_recommendations.length > 0 && (
              <>
                <div className="text-xs text-slate-500 uppercase tracking-widest mt-8 mb-2">
                  ◆ PROJECTED SQUAD (AFTER TRANSFERS)
                </div>
                <CurrentSquad
                  startingXI={results.projected_xi}
                  bench={results.projected_bench}
                  title="Projected Starting XI"
                />
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
