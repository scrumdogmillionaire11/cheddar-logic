'use client';

import { useState } from 'react';
import type { ScreenshotParseResponse, ParsedSlot } from '@/lib/fpl-api';

interface FPLParseReviewProps {
  parsed: ScreenshotParseResponse;
  onResolved: (corrected: ParsedSlot[]) => void;
}

const CONFIDENCE_LOW = 0.8;

export default function FPLParseReview({ parsed, onResolved }: FPLParseReviewProps) {
  // State must be declared before any early return (Rules of Hooks)
  const [corrections, setCorrections] = useState<Map<number, string>>(new Map());

  const squad = parsed?.squad;

  if (!squad) {
    return (
      <div className="rounded-lg border border-red-500/20 bg-red-500/5 px-4 py-6 text-center">
        <p className="text-sm text-red-400">Parse failed — no squad data returned. Please try uploading again.</p>
      </div>
    );
  }

  const allSlots = [...(squad.starters ?? []), ...(squad.bench ?? [])];
  const unresolvedIndexes = new Set(
    (squad.unresolved_slots ?? []).map((s) => s.slot_index),
  );

  // Map of slot_index -> user correction string

  const setCorrection = (slotIndex: number, value: string) => {
    setCorrections((prev) => {
      const next = new Map(prev);
      if (value.trim()) {
        next.set(slotIndex, value);
      } else {
        next.delete(slotIndex);
      }
      return next;
    });
  };

  // Confirm is disabled until ALL unresolved_slots have a correction entry
  const allResolved = [...unresolvedIndexes].every((idx) => {
    const corr = corrections.get(idx);
    return typeof corr === 'string' && corr.trim().length > 0;
  });

  const handleConfirm = () => {
    const correctedSlots: ParsedSlot[] = allSlots.map((slot) => {
      const override = corrections.get(slot.slot_index);
      if (override && override.trim()) {
        return { ...slot, display_name: override.trim() };
      }
      return slot;
    });
    onResolved(correctedSlots);
  };

  return (
    <div className="space-y-6">
      <div>
        <h2 className="mb-1 font-display text-2xl font-semibold">Review Parsed Squad</h2>
        <p className="text-cloud/60">
          Review all 15 slots. Correct any highlighted low-confidence names before confirming.
        </p>
      </div>

      {(parsed.parse_warnings ?? []).length > 0 && (
        <div className="rounded-lg border border-yellow-500/20 bg-yellow-500/5 px-4 py-3 space-y-1">
          <p className="text-xs font-medium text-yellow-400">Parse warnings</p>
          {parsed.parse_warnings.map((w, i) => (
            <p key={i} className="text-xs text-yellow-300/70">{w}</p>
          ))}
        </div>
      )}

      <div className="space-y-2">
        {allSlots.map((slot) => {
          const isLowConfidence = slot.confidence < CONFIDENCE_LOW;
          const isUnresolved = unresolvedIndexes.has(slot.slot_index);
          const correction = corrections.get(slot.slot_index) ?? '';

          return (
            <div
              key={slot.slot_index}
              className={`rounded-lg border px-4 py-3 space-y-2 ${
                isUnresolved
                  ? 'border-amber-500/40 bg-amber-500/5'
                  : isLowConfidence
                  ? 'border-yellow-500/20 bg-yellow-500/5'
                  : 'border-cloud/10 bg-surface/50'
              }`}
            >
              <div className="flex items-center justify-between gap-3 flex-wrap">
                <div className="flex items-center gap-2 min-w-0">
                  <span className="shrink-0 text-xs font-semibold text-cloud/40 w-5 text-right">
                    {slot.slot_index + 1}
                  </span>
                  <span className="shrink-0 rounded bg-cloud/10 px-1.5 py-0.5 text-xs font-semibold text-cloud/70">
                    {slot.position}
                  </span>
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-cloud truncate">
                      {slot.display_name ?? (
                        <span className="text-cloud/40 italic">unmatched</span>
                      )}
                    </p>
                  </div>
                  {slot.is_captain && (
                    <span className="shrink-0 text-xs rounded bg-teal/20 px-1.5 py-0.5 text-teal font-semibold">C</span>
                  )}
                  {slot.is_vice_captain && (
                    <span className="shrink-0 text-xs rounded bg-cloud/10 px-1.5 py-0.5 text-cloud/60 font-semibold">VC</span>
                  )}
                </div>

                {/* Confidence bar */}
                <div className="flex items-center gap-2 shrink-0">
                  <div className="w-20 h-1.5 rounded-full bg-cloud/10 overflow-hidden">
                    <div
                      className={`h-full rounded-full ${
                        slot.confidence >= 0.8
                          ? 'bg-teal'
                          : slot.confidence >= 0.5
                          ? 'bg-yellow-400'
                          : 'bg-red-400'
                      }`}
                      style={{ width: `${Math.round(slot.confidence * 100)}%` }}
                    />
                  </div>
                  <span className="text-xs text-cloud/40 w-8 text-right">
                    {Math.round(slot.confidence * 100)}%
                  </span>
                </div>
              </div>

              {/* Correction input for unresolved or low-confidence slots */}
              {(isUnresolved || isLowConfidence) && (
                <div className="flex items-center gap-2 pl-7">
                  {isUnresolved && (
                    <span className="text-xs text-amber-400 font-medium shrink-0">
                      Correction required:
                    </span>
                  )}
                  <input
                    type="text"
                    placeholder="Enter correct player name"
                    value={correction}
                    onChange={(e) => setCorrection(slot.slot_index, e.target.value)}
                    className={`flex-1 rounded border px-2 py-1 text-xs text-cloud bg-night placeholder-cloud/30 focus:outline-none ${
                      isUnresolved
                        ? 'border-amber-500/40 focus:border-amber-400'
                        : 'border-cloud/20 focus:border-teal'
                    }`}
                  />
                </div>
              )}
            </div>
          );
        })}
      </div>

      <div className="flex items-center gap-4 flex-wrap">
        <button
          onClick={handleConfirm}
          disabled={!allResolved}
          className="rounded-lg bg-teal px-6 py-2.5 text-sm font-semibold text-night transition-opacity hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed"
        >
          Confirm Squad
        </button>
        {!allResolved && unresolvedIndexes.size > 0 && (
          <p className="text-xs text-amber-400">
            {[...unresolvedIndexes].filter((idx) => {
              const corr = corrections.get(idx);
              return !corr || !corr.trim();
            }).length} unresolved slot(s) still need correction
          </p>
        )}
      </div>
    </div>
  );
}
