import { useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { getDetailedProjections, type AnalysisResults } from '@/lib/api';
import { buildDecisionViewModel } from '@/lib/decisionViewModel';
import DecisionBrief from '@/components/DecisionBrief';
import CaptaincySection from '@/components/CaptaincySection';
import ChipDecision from '@/components/ChipDecision';
import RiskNote from '@/components/RiskNote';
import TransferSection from '@/components/TransferSection';
import CurrentSquad from '@/components/CurrentSquad';
import DataTransparency from '@/components/DataTransparency';

export default function Results() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [results, setResults] = useState<AnalysisResults | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const fetchResults = async () => {
      try {
        const cachedData = sessionStorage.getItem(`analysis_${id}`);
        if (cachedData) {
          const data = JSON.parse(cachedData);
          if (data.status === 'completed' && data.results) {
            setResults(data.results);
            setLoading(false);
            return;
          }
        }

        try {
          const projections = await getDetailedProjections(id!);
          setResults(projections);
          setLoading(false);
          return;
        } catch {
          console.log('Projections endpoint not available, falling back to standard results');
        }

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

  const decision = buildDecisionViewModel(results);

  return (
    <div className="min-h-screen bg-surface-primary">
      <header className="border-b border-surface-elevated py-6">
        <div className="max-w-reading mx-auto px-6 flex justify-between items-center">
          <div className="text-body-sm text-sage-muted uppercase tracking-wider">FPL Sage</div>
          <button
            onClick={() => navigate('/')}
            className="text-body-sm text-sage-muted hover:text-sage-white transition-colors"
          >
            New analysis
          </button>
        </div>
      </header>

      <main className="max-w-reading mx-auto px-6 py-12 space-y-6">
        <DecisionBrief
          primaryAction={decision.primaryAction}
          confidence={decision.confidence}
          justification={decision.justification}
          gameweek={decision.gameweek}
          confidenceLabel={decision.confidenceLabel}
          confidenceSummary={decision.confidenceSummary}
        />

        {decision.captain && decision.viceCaptain && (
          <CaptaincySection
            captain={decision.captain}
            viceCaptain={decision.viceCaptain}
            delta={decision.captainDelta}
          />
        )}

        {(decision.startingXI.length > 0 || decision.bench.length > 0) && (
          <CurrentSquad
            title="Starting XI"
            startingXI={decision.startingXI}
            bench={decision.bench}
            formation={decision.formation}
            lineupConfidence={decision.lineupConfidence}
            formationReason={decision.formationReason}
            riskProfileEffect={decision.riskProfileEffect}
            notes={decision.lineupNotes || []}
            captainPlayerId={decision.captainPlayerId}
            viceCaptainPlayerId={decision.viceCaptainPlayerId}
          />
        )}

        <TransferSection
          {...decision.transfer}
          freeTransfers={decision.freeTransfers}
          benchWarning={decision.benchWarning}
        />

        <ChipDecision
          chipVerdict={decision.chipVerdict}
          explanation={decision.chipExplanation}
          availableChips={decision.availableChips}
          opportunityCost={decision.opportunityCost || null}
          bestGw={decision.bestGw}
          currentWindowName={decision.currentWindowName}
          bestFutureWindowName={decision.bestFutureWindowName}
        />

        <RiskNote riskStatement={decision.riskStatement} squadHealth={decision.squadHealth} />
      </main>

      <footer className="border-t border-surface-elevated mt-16">
        <div className="max-w-reading mx-auto px-6 py-8">
          <DataTransparency
            projectionWindow={decision.projectionWindow}
            updatedAt={decision.generatedAt}
            gwTimeline={decision.gwTimeline}
            warnings={[]}
          />
        </div>
      </footer>
    </div>
  );
}
