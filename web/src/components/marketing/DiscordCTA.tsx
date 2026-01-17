type DiscordCTAProps = {
  inviteUrl: string;
  communitySize: string;
  cadence: string;
};

export function DiscordCTA({ inviteUrl, communitySize, cadence }: DiscordCTAProps) {
  return (
    <section className="rounded-[2rem] border border-white/10 bg-midnight/80 p-8 shadow-panel">
      <div className="grid gap-8 items-center lg:grid-cols-2">
        <div className="space-y-3">
          <p className="text-sm font-semibold uppercase tracking-[0.3em] text-cloud/70">
            Research workshop
          </p>
          <h3 className="font-display text-3xl font-semibold text-cloud">
            Discord serves as the MVP delivery channel
          </h3>
          <p className="text-sm text-cloud/80">
            We publish methodology walk-throughs, abstention post-mortems, and calibration clinics before
            anything leaves the lab. Joining means contributing to the reasoning, not consuming picks.
          </p>
        </div>
        <div className="rounded-2xl border border-white/10 bg-surface p-6">
          <dl className="grid grid-cols-2 gap-4 text-sm text-cloud/80">
            <div>
              <dt className="text-xs uppercase tracking-[0.3em] text-cloud/60">Community size</dt>
              <dd className="mt-1 font-display text-2xl text-cloud">{communitySize}</dd>
            </div>
            <div>
              <dt className="text-xs uppercase tracking-[0.3em] text-cloud/60">Review cadence</dt>
              <dd className="mt-1 font-display text-2xl text-cloud">{cadence}</dd>
            </div>
          </dl>
          <a
            href={inviteUrl}
            target="_blank"
            rel="noreferrer noopener"
            className="mt-6 inline-flex w-full items-center justify-center rounded-full bg-teal px-6 py-3 text-base font-semibold text-night transition hover:opacity-90"
          >
            Open Discord invite
          </a>
          <p className="mt-3 text-center text-xs text-cloud/70">
            Opens in a new window. We never collect betting histories or action logs.
          </p>
        </div>
      </div>
    </section>
  );
}
