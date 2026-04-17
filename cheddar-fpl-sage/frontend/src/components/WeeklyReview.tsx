interface WeeklyReviewData {
  summary: string;
  highlights: string[];
  previousGw?: number;
  points?: number;
  pointsDelta?: number;
  rank?: number;
  rankDelta?: number;
  recommendationFollowed?: boolean;
  processVerdict?: string;
  driftFlags: string[];
}

interface WeeklyReviewProps {
  review: WeeklyReviewData;
}

const formatSignedNumber = (value?: number): string | null => {
  if (value === undefined || value === null) return null;
  return value > 0 ? `+${value}` : String(value);
};

const verdictLabel = (value?: string): string => {
  const raw = String(value || '').trim().toLowerCase();
  if (raw === 'good_process') return 'Good process';
  if (raw === 'bad_process') return 'Process drift flagged';
  return 'Process verdict pending';
};

const verdictTone = (value?: string): string => {
  const raw = String(value || '').trim().toLowerCase();
  if (raw === 'good_process') return 'text-execute';
  if (raw === 'bad_process') return 'text-veto';
  return 'text-sage-muted';
};

const recommendationLabel = (value?: boolean): string => {
  if (value === true) return 'Recommendation followed';
  if (value === false) return 'Recommendation not followed';
  return 'Recommendation follow-through unknown';
};

export default function WeeklyReview({ review }: WeeklyReviewProps) {
  const pointsDelta = formatSignedNumber(review.pointsDelta);
  const rankDelta = formatSignedNumber(review.rankDelta);

  return (
    <section className="bg-surface-card border border-surface-elevated p-8">
      <div className="flex items-baseline justify-between mb-4">
        <h2 className="text-section text-sage-muted uppercase tracking-wider">Weekly Review</h2>
        {review.previousGw !== undefined && review.previousGw !== null && (
          <span className="text-meta text-sage-muted">Reviewing GW {review.previousGw}</span>
        )}
      </div>

      <p className="text-body text-sage-light leading-relaxed max-w-2xl">{review.summary}</p>

      <div className="mt-5 grid grid-cols-1 sm:grid-cols-2 gap-4">
        {review.points !== undefined && review.points !== null && (
          <div className="p-3 border border-surface-elevated bg-surface-base">
            <div className="text-body-sm text-sage-muted">Points</div>
            <div className="text-decision text-sage-white font-medium">{review.points}</div>
          </div>
        )}

        {pointsDelta && (
          <div className="p-3 border border-surface-elevated bg-surface-base">
            <div className="text-body-sm text-sage-muted">Points Delta</div>
            <div className={`text-decision font-medium ${review.pointsDelta && review.pointsDelta >= 0 ? 'text-execute' : 'text-veto'}`}>
              {pointsDelta}
            </div>
          </div>
        )}

        {review.rank !== undefined && review.rank !== null && (
          <div className="p-3 border border-surface-elevated bg-surface-base">
            <div className="text-body-sm text-sage-muted">Overall Rank</div>
            <div className="text-decision text-sage-white font-medium">{review.rank.toLocaleString()}</div>
          </div>
        )}

        {rankDelta && (
          <div className="p-3 border border-surface-elevated bg-surface-base">
            <div className="text-body-sm text-sage-muted">Rank Delta</div>
            <div className={`text-decision font-medium ${review.rankDelta && review.rankDelta <= 0 ? 'text-execute' : 'text-veto'}`}>
              {rankDelta}
            </div>
          </div>
        )}
      </div>

      <div className="mt-5 pt-4 border-t border-surface-elevated space-y-2">
        <div className="text-body-sm text-sage-muted uppercase tracking-wider">Process Signal</div>
        <div className={`text-body font-medium ${verdictTone(review.processVerdict)}`}>{verdictLabel(review.processVerdict)}</div>
        <div className="text-body-sm text-sage-light">{recommendationLabel(review.recommendationFollowed)}</div>
      </div>

      {review.driftFlags.length > 0 && (
        <div className="mt-5 pt-4 border-t border-surface-elevated">
          <div className="text-body-sm text-sage-muted uppercase tracking-wider mb-3">Drift Flags</div>
          <div className="flex flex-wrap gap-2">
            {review.driftFlags.map((flag) => (
              <span
                key={flag}
                className="inline-flex items-center px-2.5 py-1 border border-veto/40 bg-veto/10 text-body-sm text-veto"
              >
                {flag}
              </span>
            ))}
          </div>
        </div>
      )}

      {review.highlights.length > 0 && (
        <div className="mt-5 pt-4 border-t border-surface-elevated">
          <div className="text-body-sm text-sage-muted uppercase tracking-wider mb-3">Highlights</div>
          <ul className="space-y-2">
            {review.highlights.map((highlight) => (
              <li key={highlight} className="text-body-sm text-sage-light">
                {highlight}
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
