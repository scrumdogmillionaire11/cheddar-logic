'use client';

import { useState } from 'react';
import {
  createProfile,
  type ManagerProfile,
  type OnboardingAnswers,
} from '@/lib/fpl-api';

interface FPLOnboardingProps {
  userId: string;
  onComplete?: (profile: ManagerProfile) => void;
}

const ARCHETYPE_LABELS: Record<string, string> = {
  rank_climber: 'Rank Climber',
  chip_strategist: 'Chip Strategist',
  differential_hunter: 'Differential Hunter',
  template_follower: 'Template Follower',
  wildcard_gambler: 'Wildcard Gambler',
};

export default function FPLOnboarding({ userId, onComplete }: FPLOnboardingProps) {
  const [answers, setAnswers] = useState<Partial<OnboardingAnswers>>({
    seasons_played: 1,
    transfer_frequency: 'moderate',
    primary_goal: 'rank',
    risk_appetite: 3,
    differential_captains: false,
    accept_hits: false,
  });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [profile, setProfile] = useState<ManagerProfile | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);

    try {
      const result = await createProfile({
        user_id: userId,
        onboarding_answers: answers as OnboardingAnswers,
      });
      setProfile(result);
      onComplete?.(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create profile');
    } finally {
      setLoading(false);
    }
  };

  if (profile) {
    return (
      <div className="space-y-6">
        <div>
          <h2 className="mb-1 font-display text-2xl font-semibold">Manager Profile</h2>
          <p className="text-cloud/60">Your profile has been created.</p>
        </div>
        <div className="rounded-xl border border-cloud/10 bg-surface/50 p-8 space-y-4">
          <div className="flex items-center gap-3">
            <span className="text-3xl">👤</span>
            <div>
              <p className="font-semibold text-lg">{userId}</p>
              <span className="inline-block rounded bg-teal/10 px-2 py-0.5 text-xs font-semibold text-teal">
                {ARCHETYPE_LABELS[profile.archetype] ?? profile.archetype}
              </span>
            </div>
          </div>
          <div className="rounded-lg border border-cloud/5 bg-cloud/5 px-4 py-3 text-sm space-y-1">
            <p className="text-cloud/70 font-medium">Constraints</p>
            <p className="text-cloud/50">Max hits/GW: {profile.constraints.max_hits_per_gw}</p>
            <p className="text-cloud/50">Chip deploy: {profile.constraints.chip_deploy_threshold}</p>
            <p className="text-cloud/50">Differential tolerance: {profile.constraints.differential_tolerance}</p>
            <p className="text-cloud/50">Bench investment: {profile.constraints.bench_investment_level}</p>
          </div>
          <button
            onClick={() => setProfile(null)}
            className="text-sm text-teal hover:text-teal/80 underline"
          >
            Edit profile
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="mb-1 font-display text-2xl font-semibold">Manager Profile</h2>
        <p className="text-cloud/60">
          Answer 6 questions to create your FPL manager profile and unlock archetype-aware advice.
        </p>
      </div>

      <form onSubmit={handleSubmit} className="space-y-6">
        <div className="rounded-xl border border-cloud/10 bg-surface/50 p-6 space-y-6">

          {/* 1. seasons_played */}
          <div className="space-y-2">
            <label className="block text-sm font-medium text-cloud/80">
              1. How many seasons of FPL have you played? (seasons_played)
            </label>
            <input
              type="number"
              min={0}
              max={20}
              value={answers.seasons_played ?? 1}
              onChange={(e) =>
                setAnswers((prev) => ({
                  ...prev,
                  seasons_played: Math.min(20, Math.max(0, parseInt(e.target.value) || 0)),
                }))
              }
              className="w-24 rounded border border-cloud/20 bg-night px-3 py-2 text-sm text-cloud focus:border-teal focus:outline-none"
            />
          </div>

          {/* 2. transfer_frequency */}
          <div className="space-y-2">
            <label className="block text-sm font-medium text-cloud/80">
              2. How often do you make transfers? (transfer_frequency)
            </label>
            <div className="flex flex-wrap gap-3">
              {(['minimal', 'moderate', 'active'] as const).map((opt) => (
                <label key={opt} className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="radio"
                    name="transfer_frequency"
                    value={opt}
                    checked={answers.transfer_frequency === opt}
                    onChange={() =>
                      setAnswers((prev) => ({ ...prev, transfer_frequency: opt }))
                    }
                    className="accent-teal"
                  />
                  <span className="text-sm capitalize text-cloud/80">{opt}</span>
                </label>
              ))}
            </div>
          </div>

          {/* 3. primary_goal */}
          <div className="space-y-2">
            <label className="block text-sm font-medium text-cloud/80">
              3. What is your primary goal? (primary_goal)
            </label>
            <div className="flex flex-wrap gap-3">
              {(['rank', 'enjoyment', 'competitive'] as const).map((opt) => (
                <label key={opt} className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="radio"
                    name="primary_goal"
                    value={opt}
                    checked={answers.primary_goal === opt}
                    onChange={() =>
                      setAnswers((prev) => ({ ...prev, primary_goal: opt }))
                    }
                    className="accent-teal"
                  />
                  <span className="text-sm capitalize text-cloud/80">{opt}</span>
                </label>
              ))}
            </div>
          </div>

          {/* 4. risk_appetite */}
          <div className="space-y-2">
            <label className="block text-sm font-medium text-cloud/80">
              4. Risk appetite (risk_appetite): {answers.risk_appetite}
            </label>
            <div className="flex items-center gap-3">
              <span className="text-xs text-cloud/50">Low</span>
              <input
                type="range"
                min={1}
                max={5}
                step={1}
                value={answers.risk_appetite ?? 3}
                onChange={(e) =>
                  setAnswers((prev) => ({
                    ...prev,
                    risk_appetite: parseInt(e.target.value) as 1 | 2 | 3 | 4 | 5,
                  }))
                }
                className="flex-1 accent-teal"
              />
              <span className="text-xs text-cloud/50">High</span>
            </div>
            <div className="flex justify-between px-0 text-xs text-cloud/40">
              <span>1</span>
              <span>2</span>
              <span>3</span>
              <span>4</span>
              <span>5</span>
            </div>
          </div>

          {/* 5. differential_captains */}
          <div className="space-y-2">
            <label className="block text-sm font-medium text-cloud/80">
              5. Do you use differential captains? (differential_captains)
            </label>
            <div className="flex items-center gap-3">
              <button
                type="button"
                onClick={() =>
                  setAnswers((prev) => ({ ...prev, differential_captains: true }))
                }
                className={`rounded px-4 py-1.5 text-sm font-medium transition-colors ${
                  answers.differential_captains === true
                    ? 'bg-teal text-night'
                    : 'border border-cloud/20 text-cloud/60 hover:text-cloud/80'
                }`}
              >
                Yes
              </button>
              <button
                type="button"
                onClick={() =>
                  setAnswers((prev) => ({ ...prev, differential_captains: false }))
                }
                className={`rounded px-4 py-1.5 text-sm font-medium transition-colors ${
                  answers.differential_captains === false
                    ? 'bg-teal text-night'
                    : 'border border-cloud/20 text-cloud/60 hover:text-cloud/80'
                }`}
              >
                No
              </button>
            </div>
          </div>

          {/* 6. accept_hits */}
          <div className="space-y-2">
            <label className="block text-sm font-medium text-cloud/80">
              6. Are you willing to take multiple hits when necessary? (accept_hits)
            </label>
            <div className="flex items-center gap-3">
              <button
                type="button"
                onClick={() =>
                  setAnswers((prev) => ({ ...prev, accept_hits: true }))
                }
                className={`rounded px-4 py-1.5 text-sm font-medium transition-colors ${
                  answers.accept_hits === true
                    ? 'bg-teal text-night'
                    : 'border border-cloud/20 text-cloud/60 hover:text-cloud/80'
                }`}
              >
                Yes
              </button>
              <button
                type="button"
                onClick={() =>
                  setAnswers((prev) => ({ ...prev, accept_hits: false }))
                }
                className={`rounded px-4 py-1.5 text-sm font-medium transition-colors ${
                  answers.accept_hits === false
                    ? 'bg-teal text-night'
                    : 'border border-cloud/20 text-cloud/60 hover:text-cloud/80'
                }`}
              >
                No
              </button>
            </div>
          </div>
        </div>

        {error && (
          <div className="rounded-lg border border-red-500/20 bg-red-500/10 px-4 py-3 text-sm text-red-400">
            {error}
          </div>
        )}

        <button
          type="submit"
          disabled={loading}
          className="rounded-lg bg-teal px-6 py-2.5 text-sm font-semibold text-night transition-opacity hover:opacity-90 disabled:opacity-50"
        >
          {loading ? 'Creating profile…' : 'Create profile'}
        </button>
      </form>
    </div>
  );
}
