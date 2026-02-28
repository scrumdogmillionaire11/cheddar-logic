"use client";

import { useState } from "react";
import Link from "next/link";
import { triggerAnalysis, pollForDetailedProjections, type DetailedAnalysisResponse, type AnalyzeRequest } from "@/lib/fpl-api";
import FPLDashboard from "@/components/fpl-dashboard";
import LoadingState, { ErrorState } from "@/components/fpl-loading";

const RISK_POSTURES = [
  {
    value: "conservative",
    label: "🛡️ Conservative",
    description: "Protect your rank. Don't chase.",
  },
  {
    value: "balanced",
    label: "⚖️ Balanced",
    description: "Optimal EV. Standard thresholds.",
  },
  {
    value: "aggressive",
    label: "⚡ Aggressive",
    description: "Chase the ceiling. High variance, high upside.",
  },
];

export default function FPLPageClient() {
  const [teamId, setTeamId] = useState("");
  const [state, setState] = useState<"input" | "loading" | "dashboard" | "error">("input");
  const [dashboardData, setDashboardData] = useState<DetailedAnalysisResponse | null>(null);
  const [error, setError] = useState<string>("");

  // Analysis options
  const [riskPosture, setRiskPosture] = useState<"conservative" | "balanced" | "aggressive">(
    "balanced"
  );
  const [freeTransfers, setFreeTransfers] = useState<number>(2);
  const [availableChips, setAvailableChips] = useState<string[]>(["bench_boost", "triple_captain", "free_hit"]);
  const [manualTransfers, setManualTransfers] = useState<Array<{player_out: string; player_in: string}>>([]); 
  const [injuryOverrides, setInjuryOverrides] = useState<Array<{player_name: string; status: "FIT" | "DOUBTFUL" | "OUT"; chance?: number}>>([]); 
  const [showAdvanced, setShowAdvanced] = useState(false);

  const toggleChip = (chip: string) => {
    setAvailableChips(prev => 
      prev.includes(chip) ? prev.filter(c => c !== chip) : [...prev, chip]
    );
  };

  const addManualTransfer = () => {
    setManualTransfers([...manualTransfers, { player_out: "", player_in: "" }]);
  };

  const removeManualTransfer = (index: number) => {
    setManualTransfers(manualTransfers.filter((_, i) => i !== index));
  };

  const updateManualTransfer = (index: number, field: "player_out" | "player_in", value: string) => {
    const updated = [...manualTransfers];
    updated[index][field] = value;
    setManualTransfers(updated);
  };

  const addInjuryOverride = () => {
    setInjuryOverrides([...injuryOverrides, { player_name: "", status: "FIT", chance: 100 }]);
  };

  const removeInjuryOverride = (index: number) => {
    setInjuryOverrides(injuryOverrides.filter((_, i) => i !== index));
  };

  const updateInjuryOverride = (index: number, field: "player_name" | "status" | "chance", value: string | number) => {
    const updated = [...injuryOverrides];
    if (field === "chance") {
      updated[index][field] = value as number;
    } else if (field === "status") {
      updated[index][field] = value as "FIT" | "DOUBTFUL" | "OUT";
    } else {
      updated[index][field] = value as string;
    }
    setInjuryOverrides(updated);
  };

  const handleAnalysis = async (id?: string) => {
    const targetId = id || teamId;
    const teamIdNum = parseInt(targetId);

    if (!targetId || isNaN(teamIdNum)) {
      setError("Please enter a valid Team ID");
      setState("error");
      return;
    }

    setState("loading");
    setError("");

    try {
      // Trigger analysis with risk posture and overrides
      const request: AnalyzeRequest = {
        team_id: teamIdNum,
        risk_posture: riskPosture,
        free_transfers: freeTransfers,
        available_chips: availableChips.length > 0 ? availableChips : undefined,
        manual_transfers: manualTransfers.filter(t => t.player_out && t.player_in).length > 0 
          ? manualTransfers.filter(t => t.player_out && t.player_in)
          : undefined,
        injury_overrides: injuryOverrides.filter(o => o.player_name).length > 0
          ? injuryOverrides.filter(o => o.player_name)
          : undefined,
      };

      const response = await triggerAnalysis(request);

      // Poll for completion with live updates
      const data = await pollForDetailedProjections(response.analysis_id, 120, 3000); // 120 attempts x 3s = 6 min max
      setDashboardData(data);
      setState("dashboard");

      // Update URL
      const url = new URL(window.location.href);
      url.searchParams.set("team", targetId);
      window.history.pushState({}, "", url);
    } catch (err) {
      console.error("Analysis failed:", err);
      setError(err instanceof Error ? err.message : "Analysis failed. Please try again.");
      setState("error");
    }
  };

  const handleReset = () => {
    setState("input");
    setTeamId("");
    setDashboardData(null);
    setError("");
    const url = new URL(window.location.href);
    url.searchParams.delete("team");
    window.history.pushState({}, "", url);
  };

  return (
    <div className="min-h-screen bg-night px-6 py-12 text-cloud">
      <div className="mx-auto max-w-4xl">
        <div className="mb-8">
          <Link href="/" className="text-sm text-cloud/60 hover:text-cloud/80">
            ← Back to Home
          </Link>
        </div>

        {/* Input State */}
        {state === "input" && (
          <div className="space-y-8">
            <div>
              <h1 className="mb-2 font-display text-4xl font-semibold">🧙‍♂️ FPL Sage 🧙‍♂️</h1>
              <p className="text-lg text-cloud/70">
                Deeply analytical transfer advice, chip strategy, and captain picks
              </p>
            </div>

            <div className="rounded-xl border border-white/10 bg-surface/80 p-8">
              <div className="space-y-6">
                {/* Team ID Input */}
                <div>
                  <label htmlFor="teamId" className="mb-2 block text-sm font-semibold text-cloud/70">
                    Enter your FPL Team ID
                  </label>
                  <input
                    type="text"
                    id="teamId"
                    value={teamId}
                    onChange={(e) => setTeamId(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && handleAnalysis()}
                    placeholder="e.g., 123456"
                    className="w-full rounded-lg border border-white/20 bg-surface px-4 py-3 text-cloud outline-none transition focus:border-teal"
                  />
                </div>

                {/* Risk Posture Selection */}
                <div>
                  <label className="mb-3 block text-sm font-semibold text-cloud/70">
                    Analysis Profile
                  </label>
                  <div className="grid gap-3">
                    {RISK_POSTURES.map((posture) => (
                      <button
                        key={posture.value}
                        onClick={() =>
                          setRiskPosture(posture.value as "conservative" | "balanced" | "aggressive")
                        }
                        className={`rounded-lg border-2 p-4 text-left transition ${
                          riskPosture === posture.value
                            ? "border-teal bg-teal/10"
                            : "border-white/10 bg-surface/50 hover:border-white/20"
                        }`}
                      >
                        <div className="font-semibold">{posture.label}</div>
                        <div className="text-sm text-cloud/60">{posture.description}</div>
                      </button>
                    ))}
                  </div>
                </div>

                {/* Free Transfers */}
                <div>
                  <label htmlFor="transfers" className="mb-2 block text-sm font-semibold text-cloud/70">
                    Free Transfers Available: {freeTransfers}
                  </label>
                  <input
                    type="range"
                    id="transfers"
                    min="0"
                    max="5"
                    value={freeTransfers}
                    onChange={(e) => setFreeTransfers(parseInt(e.target.value))}
                    className="w-full"
                  />
                </div>

                {/* Available Chips */}
                <div>
                  <label className="mb-3 block text-sm font-semibold text-cloud/70">
                    Available Chips
                  </label>
                  <div className="grid grid-cols-2 gap-3">
                    {[
                      { key: "bench_boost", label: "Bench Boost" },
                      { key: "triple_captain", label: "Triple Captain" },
                      { key: "free_hit", label: "Free Hit" },
                      { key: "wildcard", label: "Wildcard" },
                    ].map((chip) => (
                      <button
                        key={chip.key}
                        type="button"
                        onClick={() => toggleChip(chip.key)}
                        className={`rounded-lg border-2 p-3 text-sm transition ${
                          availableChips.includes(chip.key)
                            ? "border-teal bg-teal/10 text-teal"
                            : "border-white/10 bg-surface/50 text-cloud/60 hover:border-white/20"
                        }`}
                      >
                        <div className="font-semibold">{chip.label}</div>
                      </button>
                    ))}
                  </div>
                </div>

                {/* Advanced Options Toggle */}
                <button
                  type="button"
                  onClick={() => setShowAdvanced(!showAdvanced)}
                  className="w-full rounded-lg border border-white/20 bg-surface/50 px-4 py-2 text-sm font-semibold text-cloud/80 transition hover:border-white/40"
                >
                  {showAdvanced ? "▼" : "▶"} Advanced Options (Manual Transfers & Injury Overrides)
                </button>

                {/* Advanced Options */}
                {showAdvanced && (
                  <div className="space-y-6 rounded-lg border border-white/10 bg-surface/50 p-6">
                    {/* Manual Transfers */}
                    <div>
                      <div className="mb-3 flex items-center justify-between">
                        <label className="text-sm font-semibold text-cloud/70">
                          Manual Transfers (already made on FPL site)
                        </label>
                        <button
                          type="button"
                          onClick={addManualTransfer}
                          className="rounded bg-teal/20 px-3 py-1 text-xs font-semibold text-teal hover:bg-teal/30"
                        >
                          + Add Transfer
                        </button>
                      </div>
                      {manualTransfers.map((transfer, idx) => (
                        <div key={idx} className="mb-3 flex gap-2">
                          <input
                            type="text"
                            placeholder="Player out"
                            value={transfer.player_out}
                            onChange={(e) => updateManualTransfer(idx, "player_out", e.target.value)}
                            className="flex-1 rounded-lg border border-white/20 bg-surface px-3 py-2 text-sm text-cloud outline-none focus:border-teal"
                          />
                          <span className="flex items-center text-cloud/60">→</span>
                          <input
                            type="text"
                            placeholder="Player in"
                            value={transfer.player_in}
                            onChange={(e) => updateManualTransfer(idx, "player_in", e.target.value)}
                            className="flex-1 rounded-lg border border-white/20 bg-surface px-3 py-2 text-sm text-cloud outline-none focus:border-teal"
                          />
                          <button
                            type="button"
                            onClick={() => removeManualTransfer(idx)}
                            className="rounded bg-red-500/20 px-3 py-2 text-xs font-semibold text-red-400 hover:bg-red-500/30"
                          >
                            ✕
                          </button>
                        </div>
                      ))}
                      {manualTransfers.length === 0 && (
                        <p className="text-xs text-cloud/50">No manual transfers added</p>
                      )}
                    </div>

                    {/* Injury Overrides */}
                    <div>
                      <div className="mb-3 flex items-center justify-between">
                        <label className="text-sm font-semibold text-cloud/70">
                          Injury Overrides
                        </label>
                        <button
                          type="button"
                          onClick={addInjuryOverride}
                          className="rounded bg-teal/20 px-3 py-1 text-xs font-semibold text-teal hover:bg-teal/30"
                        >
                          + Add Override
                        </button>
                      </div>
                      {injuryOverrides.map((override, idx) => (
                        <div key={idx} className="mb-3 flex gap-2">
                          <input
                            type="text"
                            placeholder="Player name"
                            value={override.player_name}
                            onChange={(e) => updateInjuryOverride(idx, "player_name", e.target.value)}
                            className="flex-1 rounded-lg border border-white/20 bg-surface px-3 py-2 text-sm text-cloud outline-none focus:border-teal"
                          />
                          <select
                            value={override.status}
                            onChange={(e) => updateInjuryOverride(idx, "status", e.target.value)}
                            className="w-32 rounded-lg border border-white/20 bg-surface px-3 py-2 text-sm text-cloud outline-none focus:border-teal"
                          >
                            <option value="FIT">Fit</option>
                            <option value="DOUBTFUL">Doubtful</option>
                            <option value="OUT">Out</option>
                          </select>
                          <input
                            type="number"
                            placeholder="%"
                            min="0"
                            max="100"
                            value={override.chance}
                            onChange={(e) => updateInjuryOverride(idx, "chance", parseInt(e.target.value) || 0)}
                            className="w-20 rounded-lg border border-white/20 bg-surface px-3 py-2 text-sm text-cloud outline-none focus:border-teal"
                          />
                          <button
                            type="button"
                            onClick={() => removeInjuryOverride(idx)}
                            className="rounded bg-red-500/20 px-3 py-2 text-xs font-semibold text-red-400 hover:bg-red-500/30"
                          >
                            ✕
                          </button>
                        </div>
                      ))}
                      {injuryOverrides.length === 0 && (
                        <p className="text-xs text-cloud/50">No injury overrides added</p>
                      )}
                    </div>
                  </div>
                )}

                {/* Analyze Button */}
                <button
                  type="button"
                  onClick={() => handleAnalysis()}
                  disabled={!teamId}
                  className="w-full rounded-lg bg-teal px-6 py-3 font-semibold text-night transition hover:opacity-90 disabled:opacity-50"
                >
                  Analyze Team
                </button>
              </div>
            </div>

            {/* How to find Your Team ID */}
            <div className="rounded-xl border border-white/10 bg-surface/80 p-8">
              <h2 className="mb-4 text-xl font-semibold">How to find your Team ID</h2>
              <ol className="list-decimal space-y-2 pl-5 text-cloud/70">
                <li>Go to the Fantasy Premier League website</li>
                <li>Navigate to your team page</li>
                <li>Look at the URL - your Team ID is the number after &quot;entry/&quot;</li>
                <li>Example: fantasy.premierleague.com/entry/123456/</li>
              </ol>
            </div>
          </div>
        )}

        {/* Loading State */}
        {state === "loading" && (
          <div className="space-y-6">
            <div>
              <h1 className="mb-2 font-display text-4xl font-semibold">
                Analyzing Team {teamId}
              </h1>
              <p className="text-sm text-cloud/60">Profile: {riskPosture}</p>
            </div>
            <LoadingState />
            <div className="rounded-lg border border-white/10 bg-surface/50 p-4 text-center">
              <p className="text-sm text-cloud/60">
                ⏳ Checking analysis status every 3 seconds...
              </p>
              <p className="mt-1 text-xs text-cloud/50">
                This can take 30-90 seconds for full analysis
              </p>
            </div>
          </div>
        )}

        {/* Dashboard State - Show form at top, results below */}
        {state === "dashboard" && dashboardData && (
          <div className="space-y-8">
            {/* Form sticky at top */}
            <div className="rounded-xl border border-white/10 bg-surface/80 p-6">
              <div className="mb-4 flex items-center justify-between">
                <h2 className="text-lg font-semibold">Configure Analysis</h2>
                <button
                  onClick={handleReset}
                  className="rounded-lg border border-white/20 bg-surface/50 px-3 py-1.5 text-sm font-semibold transition hover:border-white/40"
                >
                  Reset
                </button>
              </div>
              <div className="grid gap-4 md:grid-cols-4">
                <div>
                  <label className="mb-2 block text-xs font-semibold text-cloud/70">Team ID</label>
                  <input
                    type="text"
                    value={teamId}
                    onChange={(e) => setTeamId(e.target.value)}
                    className="w-full rounded-lg border border-white/20 bg-surface px-3 py-2 text-sm text-cloud outline-none transition focus:border-teal"
                  />
                </div>
                <div>
                  <label className="mb-2 block text-xs font-semibold text-cloud/70">Risk Posture</label>
                  <select
                    value={riskPosture}
                    onChange={(e) => setRiskPosture(e.target.value as "conservative" | "balanced" | "aggressive")}
                    className="w-full rounded-lg border border-white/20 bg-surface px-3 py-2 text-sm text-cloud outline-none transition focus:border-teal"
                  >
                    <option value="conservative">🛡️ Conservative</option>
                    <option value="balanced">⚖️ Balanced</option>
                    <option value="aggressive">⚡ Aggressive</option>
                  </select>
                </div>
                <div>
                  <label className="mb-2 block text-xs font-semibold text-cloud/70">Free Transfers: {freeTransfers}</label>
                  <input
                    type="range"
                    min="0"
                    max="5"
                    value={freeTransfers}
                    onChange={(e) => setFreeTransfers(parseInt(e.target.value))}
                    className="w-full"
                  />
                </div>
                <div>
                  <label className="mb-2 block text-xs font-semibold text-cloud/70">Available Chips</label>
                  <div className="flex gap-1 text-xs">
                    {[
                      { key: "bench_boost", label: "BB" },
                      { key: "triple_captain", label: "TC" },
                      { key: "free_hit", label: "FH" },
                      { key: "wildcard", label: "WC" },
                    ].map((chip) => (
                      <button
                        key={chip.key}
                        type="button"
                        onClick={() => toggleChip(chip.key)}
                        className={`flex-1 rounded border px-2 py-1 font-semibold transition ${
                          availableChips.includes(chip.key)
                            ? "border-teal bg-teal/10 text-teal"
                            : "border-white/10 text-cloud/40"
                        }`}
                      >
                        {chip.label}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
              
              {/* Advanced section toggle for dashboard */}
              {showAdvanced && (
                <div className="mt-4 space-y-3 rounded-lg border border-white/10 bg-surface/50 p-4">
                  <div className="text-xs font-semibold text-cloud/70">
                    Manual Transfers: {manualTransfers.filter(t => t.player_out && t.player_in).length}
                    {" • "}
                    Injury Overrides: {injuryOverrides.filter(o => o.player_name).length}
                  </div>
                </div>
              )}
              
              <div className="mt-4 flex gap-2">
                <button
                  type="button"
                  onClick={() => setShowAdvanced(!showAdvanced)}
                  className="flex-shrink-0 rounded-lg border border-white/20 bg-surface/50 px-3 py-2 text-xs font-semibold text-cloud/80 transition hover:border-white/40"
                >
                  {showAdvanced ? "▼" : "▶"} Advanced
                </button>
                <button
                  type="button"
                  onClick={() => handleAnalysis()}
                  className="flex-1 rounded-lg bg-teal px-4 py-2 text-sm font-semibold text-night transition hover:opacity-90"
                >
                  Re-analyze
                </button>
              </div>
            </div>

            {/* Results below */}
            <div>
              <h1 className="mb-6 font-display text-4xl font-semibold">
                Team {teamId} Analysis
              </h1>
              <FPLDashboard data={dashboardData} />
            </div>
          </div>
        )}

        {/* Error State */}
        {state === "error" && (
          <div className="space-y-6">
            <div>
              <h1 className="mb-2 font-display text-4xl font-semibold">FPL Team Analysis</h1>
            </div>
            <ErrorState error={error} onRetry={() => setState("input")} />
          </div>
        )}
      </div>
    </div>
  );
}
