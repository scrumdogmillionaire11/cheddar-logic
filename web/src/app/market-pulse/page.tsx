import { Metadata } from 'next';
import MarketPulseClient from '@/components/market-pulse/MarketPulseClient';

export const metadata: Metadata = {
  title: 'Market Pulse',
  description: 'Real-time odds divergence monitor across major sportsbooks.',
};

function formatScheduleLabel(): string {
  const slotMinutes = Number(process.env.ODDS_FETCH_SLOT_MINUTES || 60);
  const startHour = Number(process.env.ODDS_FETCH_START_HOUR || 7);
  const safeSlotMinutes = Number.isFinite(slotMinutes) && slotMinutes > 0 ? slotMinutes : 60;
  const safeStartHour = Number.isFinite(startHour) && startHour >= 0 && startHour <= 23
    ? startHour
    : 7;

  const startHour12 = safeStartHour % 12 === 0 ? 12 : safeStartHour % 12;
  const meridiem = safeStartHour >= 12 ? 'PM' : 'AM';
  const cadenceLabel =
    safeSlotMinutes === 60 ? 'Odds update schedule: hourly' : `Odds update schedule: every ${safeSlotMinutes} minutes`;

  return `${cadenceLabel}, starting at ${startHour12}:00 ${meridiem} ET and continuing through the day.`;
}

export default function MarketPulsePage() {
  const scheduleLabel = formatScheduleLabel();

  return (
    <main className="mx-auto max-w-5xl px-4 py-8 text-cloud">
      <div className="mb-6 rounded-3xl border border-white/10 bg-[radial-gradient(circle_at_top_left,rgba(34,211,238,0.18),transparent_38%),linear-gradient(180deg,rgba(255,255,255,0.07),rgba(255,255,255,0.03))] px-6 py-6 shadow-[0_20px_60px_rgba(0,0,0,0.28)]">
        <p className="text-xs font-semibold uppercase tracking-[0.24em] text-cloud/50">
          Discrepancy scouting surface
        </p>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight">Market Pulse</h1>
        <p className="mt-2 max-w-2xl text-sm text-cloud/60">
          Best observed price gaps, freshness context, and model confirmation where the mapping is trustworthy.
        </p>
        <p className="mt-3 text-xs text-cloud/45">
          {scheduleLabel}
        </p>
      </div>
      <MarketPulseClient scheduleLabel={scheduleLabel} />
    </main>
  );
}
