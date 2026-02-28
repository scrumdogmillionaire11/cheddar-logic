import CardsContainer from '@/components/cards-container';

export default function AnalyticsPage() {
  // In production, this would get the game ID from URL params or API
  const demoGameId = 'game-nhl-2026-02-27-001';

  return (
    <main className="min-h-screen bg-gradient-to-b from-slate-950 via-slate-900 to-slate-950 text-white">
      {/* Header */}
      <div className="border-b border-slate-700 bg-slate-900/50 backdrop-blur">
        <div className="mx-auto max-w-6xl px-6 py-12">
          <h1 className="text-4xl font-bold tracking-tight">
            Analytical Outputs
          </h1>
          <p className="mt-3 text-lg text-slate-300">
            Signal-qualified model predictions with confidence-weighted analysis
          </p>
        </div>
      </div>

      {/* Content */}
      <div className="mx-auto max-w-6xl px-6 py-12">
        <div className="space-y-8">
          {/* Explanation Section */}
          <section className="rounded-xl border border-slate-700 bg-slate-900/50 p-8 space-y-4">
            <h2 className="text-2xl font-semibold text-white">
              How to Read These Cards
            </h2>
            
            <div className="space-y-4 text-slate-300">
              <p>
                Each card represents a point-in-time analytical output from one of our probabilistic models. Here&apos;s what you&apos;re seeing:
              </p>
              
              <ul className="space-y-2 list-disc list-inside text-slate-300">
                <li>
                  <strong>Confidence Score:</strong> The model&apos;s estimated probability of accuracy for this prediction
                </li>
                <li>
                  <strong>Prediction:</strong> The model&apos;s preference (HOME/AWAY) with reasoning
                </li>
                <li>
                  <strong>Odds Context:</strong> The market odds snapshot at the time of analysis
                </li>
                <li>
                  <strong>Expiration:</strong> Cards expire 1 hour before game start to prevent stale information
                </li>
                <li>
                  <strong>Abstention:</strong> If a card is missing, the model abstained due to insufficient confidence
                </li>
              </ul>
            </div>

            <div className="rounded-lg bg-amber-900/30 border border-amber-700/50 p-4">
              <p className="text-sm text-amber-100">
                <strong>Educational Disclaimer:</strong> These outputs are provided for analytical education and research purposes only. They are not betting advice, investment recommendations, or actionable directives. All decisions remain solely yours.
              </p>
            </div>
          </section>

          {/* Cards Demo Section */}
          <section className="space-y-4">
            <div className="space-y-2">
              <h2 className="text-2xl font-semibold text-white">
                Sample Cards
              </h2>
              <p className="text-slate-400">
                Showing cards for game ID: <code className="text-slate-300 bg-slate-800 px-2 py-1 rounded">{demoGameId}</code>
              </p>
            </div>

            {/* Cards Container - This will fetch and display real cards */}
            <CardsContainer 
              gameId={demoGameId}
              maxCards={10}
            />
          </section>

          {/* How It Works Section */}
          <section className="rounded-xl border border-slate-700 bg-slate-900/50 p-8 space-y-4">
            <h2 className="text-2xl font-semibold text-white">
              How This Works
            </h2>
            
            <div className="space-y-4 text-slate-300">
              <p>
                Our analytical pipeline runs continuously:
              </p>
              
              <ol className="space-y-3 list-decimal list-inside text-slate-300">
                <li>
                  <strong>Odds Ingestion:</strong> We capture current market odds every hour from major sportsbooks
                </li>
                <li>
                  <strong>Model Inference:</strong> Our trained models analyze odds, historical data, and market signals
                </li>
                <li>
                  <strong>Confidence Filtering:</strong> Only predictions meeting our confidence thresholds become cards
                </li>
                <li>
                  <strong>Card Generation:</strong> High-confidence outputs are packaged as web-ready analytical cards
                </li>
                <li>
                  <strong>Display & Expiration:</strong> Cards remain visible until 1 hour before game start, then automatically expire
                </li>
              </ol>
            </div>

            <div className="rounded-lg bg-slate-800/50 p-4 border border-slate-600">
              <p className="text-sm text-slate-300">
                <strong>Key Feature: Abstention-First Logic</strong><br />
                When our models are uncertain, they produce no output. A blank card display means the model correctly identified insufficient signal, not that it crashed or failed.
              </p>
            </div>
          </section>

          {/* API Integration Section */}
          <section className="rounded-xl border border-slate-700 bg-slate-900/50 p-8 space-y-4">
            <h2 className="text-2xl font-semibold text-white">
              Using the API
            </h2>
            
            <p className="text-slate-300">
              Cards are served via a stateless JSON API that integrates with your own applications:
            </p>

            <div className="rounded-lg bg-slate-800/50 p-4 border border-slate-600 font-mono text-sm">
              <p className="text-slate-400 mb-2">Fetch cards for a game:</p>
              <p className="text-green-400">
                GET /api/cards/game-nhl-2026-02-27-001
              </p>
            </div>

            <div className="rounded-lg bg-slate-800/50 p-4 border border-slate-600 font-mono text-sm">
              <p className="text-slate-400 mb-2">Filter by card type:</p>
              <p className="text-green-400">
                GET /api/cards/game-nhl-2026-02-27-001?cardType=nhl-model-output
              </p>
            </div>

            <p className="text-slate-300">
              Response includes all analytical context: odds snapshot, confidence, reasoning, game metadata, and expiration timestamp.
            </p>
          </section>
        </div>
      </div>
    </main>
  );
}
