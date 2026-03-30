'use client';

import { useState } from 'react';
import {
  createDraftSession,
  generateDraft,
  type DraftCandidate,
  type DraftGenerateResponse,
} from '@/lib/fpl-api';
import FPLDraftCandidateCard from '@/components/fpl-draft-candidate-card';

interface FPLDraftLabProps {
  userId: string;
}

type RiskMode = 'normal' | 'reduce' | 'upside';

export default function FPLDraftLab({ userId }: FPLDraftLabProps) {
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [candidates, setCandidates] = useState<DraftCandidate[]>([]);
  const [lockedIds, setLockedIds] = useState<Set<string | number>>(new Set());
  const [bannedIds, setBannedIds] = useState<Set<string | number>>(new Set());
  const [isGenerating, setIsGenerating] = useState(false);
  const [generatedSquad, setGeneratedSquad] = useState<DraftGenerateResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [riskMode, setRiskMode] = useState<RiskMode>('normal');
  const [isCreatingSession, setIsCreatingSession] = useState(false);

  // Add-candidate form state
  const [formName, setFormName] = useState('');
  const [formTeam, setFormTeam] = useState('');
  const [formPosition, setFormPosition] = useState<DraftCandidate['position']>('MID');
  const [formPrice, setFormPrice] = useState('');

  // Lock/ban inline input
  const [lockInputName, setLockInputName] = useState('');
  const [showLockInput, setShowLockInput] = useState(false);
  const [banInputName, setBanInputName] = useState('');
  const [showBanInput, setShowBanInput] = useState(false);

  const handleNewSession = async () => {
    setIsCreatingSession(true);
    setError(null);
    try {
      const session = await createDraftSession({ user_id: userId });
      setSessionId(session.session_id);
      setGeneratedSquad(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create session');
    } finally {
      setIsCreatingSession(false);
    }
  };

  const handleAddCandidate = () => {
    if (!formName.trim() || !formTeam.trim() || !formPrice.trim()) return;
    const price = parseFloat(formPrice);
    if (isNaN(price)) return;

    const newCandidate: DraftCandidate = {
      player_id: `${Date.now()}-${Math.random()}`,
      name: formName.trim(),
      team: formTeam.trim(),
      position: formPosition,
      price,
    };
    setCandidates((prev) => [...prev, newCandidate]);
    setFormName('');
    setFormTeam('');
    setFormPrice('');
  };

  const handleGenerate = async () => {
    if (!sessionId || candidates.length < 1) return;
    setIsGenerating(true);
    setError(null);
    try {
      const result = await generateDraft(sessionId);
      setGeneratedSquad(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to generate squad');
    } finally {
      setIsGenerating(false);
    }
  };

  const toggleLock = (playerId: string | number) => {
    setLockedIds((prev) => {
      const next = new Set(prev);
      if (next.has(playerId)) {
        next.delete(playerId);
      } else {
        next.add(playerId);
      }
      return next;
    });
  };

  const toggleBan = (playerId: string | number) => {
    setBannedIds((prev) => {
      const next = new Set(prev);
      if (next.has(playerId)) {
        next.delete(playerId);
      } else {
        next.add(playerId);
      }
      return next;
    });
  };

  const removeCandidate = (playerId: string | number) => {
    setCandidates((prev) => prev.filter((c) => c.player_id !== playerId));
    setLockedIds((prev) => {
      const next = new Set(prev);
      next.delete(playerId);
      return next;
    });
    setBannedIds((prev) => {
      const next = new Set(prev);
      next.delete(playerId);
      return next;
    });
  };

  const handleLockByName = () => {
    const found = candidates.find(
      (c) => c.name.toLowerCase() === lockInputName.trim().toLowerCase(),
    );
    if (found) {
      setLockedIds((prev) => new Set([...prev, found.player_id]));
      setLockInputName('');
      setShowLockInput(false);
    }
  };

  const handleBanByName = () => {
    const found = candidates.find(
      (c) => c.name.toLowerCase() === banInputName.trim().toLowerCase(),
    );
    if (found) {
      setBannedIds((prev) => new Set([...prev, found.player_id]));
      setBanInputName('');
      setShowBanInput(false);
    }
  };

  return (
    <div className="space-y-6">
      <div>
        <h2 className="mb-1 font-display text-2xl font-semibold">Build Lab</h2>
        <p className="text-cloud/60">
          Create a draft session, add candidates, apply constraints, and generate your squad.
        </p>
      </div>

      {/* Session control */}
      <div className="rounded-xl border border-cloud/10 bg-surface/50 p-5">
        <div className="flex items-center gap-4 flex-wrap">
          <button
            onClick={handleNewSession}
            disabled={isCreatingSession}
            className="rounded-lg bg-teal px-4 py-2 text-sm font-semibold text-night transition-opacity hover:opacity-90 disabled:opacity-50"
          >
            {isCreatingSession ? 'Creating…' : 'New session'}
          </button>
          {sessionId && (
            <div className="flex items-center gap-2">
              <span className="text-xs text-cloud/40">Session:</span>
              <code className="text-xs text-teal font-mono">{sessionId}</code>
            </div>
          )}
        </div>
      </div>

      {/* Add-candidate form */}
      <div className="rounded-xl border border-cloud/10 bg-surface/50 p-5 space-y-4">
        <p className="text-sm font-medium text-cloud/80">Add candidate player</p>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <input
            type="text"
            placeholder="Name"
            value={formName}
            onChange={(e) => setFormName(e.target.value)}
            className="rounded border border-cloud/20 bg-night px-3 py-2 text-sm text-cloud placeholder-cloud/30 focus:border-teal focus:outline-none"
          />
          <input
            type="text"
            placeholder="Team"
            value={formTeam}
            onChange={(e) => setFormTeam(e.target.value)}
            className="rounded border border-cloud/20 bg-night px-3 py-2 text-sm text-cloud placeholder-cloud/30 focus:border-teal focus:outline-none"
          />
          <select
            value={formPosition}
            onChange={(e) => setFormPosition(e.target.value as DraftCandidate['position'])}
            className="rounded border border-cloud/20 bg-night px-3 py-2 text-sm text-cloud focus:border-teal focus:outline-none"
          >
            <option value="GK">GK</option>
            <option value="DEF">DEF</option>
            <option value="MID">MID</option>
            <option value="FWD">FWD</option>
          </select>
          <input
            type="number"
            placeholder="Price (£m)"
            value={formPrice}
            onChange={(e) => setFormPrice(e.target.value)}
            min={0}
            step={0.1}
            className="rounded border border-cloud/20 bg-night px-3 py-2 text-sm text-cloud placeholder-cloud/30 focus:border-teal focus:outline-none"
          />
        </div>
        <button
          onClick={handleAddCandidate}
          disabled={!formName.trim() || !formTeam.trim() || !formPrice.trim()}
          className="rounded bg-cloud/10 px-4 py-1.5 text-sm text-cloud/80 hover:bg-cloud/20 transition-colors disabled:opacity-40"
        >
          Add
        </button>
      </div>

      {/* Constraint strip */}
      <div className="rounded-xl border border-cloud/10 bg-surface/50 p-5 space-y-3">
        <p className="text-sm font-medium text-cloud/80">Constraint controls</p>
        <div className="flex flex-wrap gap-2">
          <button
            onClick={() => setShowLockInput((v) => !v)}
            className="rounded border border-cloud/20 px-3 py-1.5 text-xs text-cloud/70 hover:border-teal/40 hover:text-teal transition-colors"
          >
            🔒 Lock player
          </button>
          <button
            onClick={() => setShowBanInput((v) => !v)}
            className="rounded border border-cloud/20 px-3 py-1.5 text-xs text-cloud/70 hover:border-red-400/40 hover:text-red-400 transition-colors"
          >
            ✕ Ban player
          </button>
          <button
            onClick={() => setRiskMode(riskMode === 'reduce' ? 'normal' : 'reduce')}
            className={`rounded border px-3 py-1.5 text-xs transition-colors ${
              riskMode === 'reduce'
                ? 'border-teal/40 bg-teal/10 text-teal'
                : 'border-cloud/20 text-cloud/70 hover:border-teal/40 hover:text-teal'
            }`}
          >
            Reduce risk
          </button>
          <button
            onClick={() => setRiskMode(riskMode === 'upside' ? 'normal' : 'upside')}
            className={`rounded border px-3 py-1.5 text-xs transition-colors ${
              riskMode === 'upside'
                ? 'border-yellow-400/40 bg-yellow-400/10 text-yellow-300'
                : 'border-cloud/20 text-cloud/70 hover:border-yellow-400/40 hover:text-yellow-300'
            }`}
          >
            Favor upside
          </button>
        </div>
        {showLockInput && (
          <div className="flex gap-2 items-center">
            <input
              type="text"
              placeholder="Player name to lock"
              value={lockInputName}
              onChange={(e) => setLockInputName(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleLockByName()}
              className="rounded border border-cloud/20 bg-night px-3 py-1.5 text-sm text-cloud placeholder-cloud/30 focus:border-teal focus:outline-none"
            />
            <button
              onClick={handleLockByName}
              className="rounded bg-teal/20 px-3 py-1.5 text-xs text-teal hover:bg-teal/30"
            >
              Lock
            </button>
          </div>
        )}
        {showBanInput && (
          <div className="flex gap-2 items-center">
            <input
              type="text"
              placeholder="Player name to ban"
              value={banInputName}
              onChange={(e) => setBanInputName(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleBanByName()}
              className="rounded border border-cloud/20 bg-night px-3 py-1.5 text-sm text-cloud placeholder-cloud/30 focus:border-teal focus:outline-none"
            />
            <button
              onClick={handleBanByName}
              className="rounded bg-red-500/20 px-3 py-1.5 text-xs text-red-400 hover:bg-red-500/30"
            >
              Ban
            </button>
          </div>
        )}
        {riskMode !== 'normal' && (
          <p className="text-xs text-cloud/40">
            Risk mode: <span className="text-cloud/60 font-medium capitalize">{riskMode}</span>
            {' '}(applied to generate call)
          </p>
        )}
      </div>

      {/* Candidates list */}
      {candidates.length > 0 && (
        <div className="space-y-2">
          <p className="text-sm text-cloud/50">{candidates.length} candidate{candidates.length !== 1 ? 's' : ''}</p>
          <div className="space-y-2">
            {candidates.map((candidate) => (
              <FPLDraftCandidateCard
                key={candidate.player_id}
                candidate={candidate}
                isLocked={lockedIds.has(candidate.player_id)}
                isBanned={bannedIds.has(candidate.player_id)}
                onLock={() => toggleLock(candidate.player_id)}
                onBan={() => toggleBan(candidate.player_id)}
                onRemove={() => removeCandidate(candidate.player_id)}
              />
            ))}
          </div>
        </div>
      )}

      {/* Generate squad */}
      <div>
        <button
          onClick={handleGenerate}
          disabled={!sessionId || candidates.length < 1 || isGenerating}
          className="rounded-lg bg-teal px-6 py-2.5 text-sm font-semibold text-night transition-opacity hover:opacity-90 disabled:opacity-40"
        >
          {isGenerating ? 'Generating…' : 'Generate squad'}
        </button>
        {!sessionId && (
          <p className="mt-1 text-xs text-cloud/40">Start a session first</p>
        )}
        {sessionId && candidates.length < 1 && (
          <p className="mt-1 text-xs text-cloud/40">Add at least 1 candidate</p>
        )}
      </div>

      {error && (
        <div className="rounded-lg border border-red-500/20 bg-red-500/10 px-4 py-3 text-sm text-red-400">
          {error}
        </div>
      )}

      {/* Generated squad results */}
      {generatedSquad && (
        <div className="rounded-xl border border-teal/20 bg-teal/5 p-5 space-y-4">
          <p className="font-medium text-teal">Generated squad</p>
          <blockquote className="border-l-2 border-teal/30 pl-3 text-sm text-cloud/70 italic">
            {generatedSquad.rationale}
          </blockquote>
          {generatedSquad.generated_squad.length > 0 && (
            <div className="space-y-2">
              {generatedSquad.generated_squad.map((c) => (
                <FPLDraftCandidateCard key={c.player_id} candidate={c} />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
