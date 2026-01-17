import type { AnalyticsStatus } from "@/lib/config";

const STATUS_COPY = {
  online: {
    label: "Analytics online",
    message: "Model diagnostics are visible. Toggle lives in env NEXT_PUBLIC_ANALYTICS_STATUS.",
    accent: "bg-teal/20 text-teal",
  },
  paused: {
    label: "Analytics paused",
    message:
      "Visuals suppressed by compliance request. Methodology narrative remains available for reference.",
    accent: "bg-rose/10 text-rose",
  },
};

type KillSwitchBannerProps = {
  status: AnalyticsStatus;
};

export function KillSwitchBanner({ status }: KillSwitchBannerProps) {
  const copy = STATUS_COPY[status.state];

  return (
    <aside className="rounded-[1.5rem] border border-white/10 bg-surface-muted/70 px-6 py-4 text-sm text-cloud/80">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-3">
          <span className={`rounded-full px-4 py-1 text-xs font-semibold uppercase ${copy.accent}`}>
            {copy.label}
          </span>
          <p>{copy.message}</p>
        </div>
        <p className="text-xs text-cloud/60">
          Last updated {new Date(status.lastUpdated).toLocaleString(undefined, {
            dateStyle: "medium",
            timeStyle: "short",
          })}
        </p>
      </div>
    </aside>
  );
}
