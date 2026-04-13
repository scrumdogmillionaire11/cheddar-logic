'use client';

import { useEffect, useState, useCallback } from 'react';

// ── Types ──────────────────────────────────────────────────────────────────

interface PlayerShotRow {
  id: string;
  player_name: string | null;
  player_id: number;
  game_date: string | null;
  opponent: string | null;
  is_home: number;
  shots: number | null;
  toi_minutes: number | null;
  fetched_at: string;
}

interface PlayerBlkRow {
  id: string;
  player_name: string | null;
  player_id: number;
  game_date: string | null;
  opponent: string | null;
  is_home: number;
  blocked_shots: number | null;
  toi_minutes: number | null;
  fetched_at: string;
}

interface PitcherKRow {
  id: string;
  full_name: string | null;
  mlb_pitcher_id: number;
  team: string | null;
  game_date: string;
  opponent: string | null;
  home_away: string | null;
  innings_pitched: number | null;
  strikeouts: number | null;
  walks: number | null;
  hits: number | null;
  earned_runs: number | null;
  updated_at: string;
}

// ── Helpers ────────────────────────────────────────────────────────────────

function formatAge(ts: string) {
  try {
    const ms = Date.now() - new Date(ts).getTime();
    const mins = Math.floor(ms / 60000);
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs}h ${mins % 60}m ago`;
    return `${Math.floor(hrs / 24)}d ago`;
  } catch {
    return '?';
  }
}

function ip(val: number | null) {
  if (val == null) return '—';
  const full = Math.floor(val);
  const thirds = Math.round((val - full) * 3);
  return thirds === 0 ? `${full}` : `${full}.${thirds}`;
}

function num(val: number | null) {
  return val == null ? '—' : String(val);
}

// ── Sub-components ─────────────────────────────────────────────────────────

function LoadingRow({ cols }: { cols: number }) {
  return (
    <tr>
      <td colSpan={cols} className="px-3 py-4 text-center text-sm text-cloud/50">
        Loading…
      </td>
    </tr>
  );
}

function ErrorRow({ cols, msg }: { cols: number; msg: string }) {
  return (
    <tr>
      <td colSpan={cols} className="px-3 py-4 text-center text-sm text-red-400">
        {msg}
      </td>
    </tr>
  );
}

function EmptyRow({ cols }: { cols: number }) {
  return (
    <tr>
      <td colSpan={cols} className="px-3 py-4 text-center text-sm text-cloud/40">
        No data
      </td>
    </tr>
  );
}

function Th({ children }: { children: React.ReactNode }) {
  return (
    <th className="px-3 py-2 text-left text-xs font-semibold uppercase tracking-wide text-cloud/50">
      {children}
    </th>
  );
}

// ── Player Shots Table ─────────────────────────────────────────────────────

function ShotsTable({
  rows,
  loading,
  error,
}: {
  rows: PlayerShotRow[];
  loading: boolean;
  error: string | null;
}) {
  const COLS = 7;
  return (
    <div className="overflow-x-auto rounded-lg border border-white/10">
      <table className="w-full text-sm">
        <thead className="bg-white/5">
          <tr>
            <Th>Player</Th>
            <Th>Date</Th>
            <Th>Opp</Th>
            <Th>H/A</Th>
            <Th>Shots</Th>
            <Th>TOI</Th>
            <Th>Fetched</Th>
          </tr>
        </thead>
        <tbody className="divide-y divide-white/5">
          {loading ? (
            <LoadingRow cols={COLS} />
          ) : error ? (
            <ErrorRow cols={COLS} msg={error} />
          ) : rows.length === 0 ? (
            <EmptyRow cols={COLS} />
          ) : (
            rows.map((r) => (
              <tr key={r.id} className="hover:bg-white/5">
                <td className="px-3 py-2 font-medium text-cloud">
                  {r.player_name ?? `#${r.player_id}`}
                </td>
                <td className="px-3 py-2 text-cloud/70">{r.game_date ?? '—'}</td>
                <td className="px-3 py-2 text-cloud/70">{r.opponent ?? '—'}</td>
                <td className="px-3 py-2 text-cloud/50">
                  {r.is_home ? 'H' : 'A'}
                </td>
                <td className="px-3 py-2 text-right font-mono font-semibold text-blue-300">
                  {num(r.shots)}
                </td>
                <td className="px-3 py-2 text-right font-mono text-cloud/60">
                  {r.toi_minutes != null ? r.toi_minutes.toFixed(1) : '—'}
                </td>
                <td className="px-3 py-2 text-right text-cloud/40 text-xs">
                  {formatAge(r.fetched_at)}
                </td>
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}

// ── Player Blocked Shots Table ─────────────────────────────────────────────

function BlkTable({
  rows,
  loading,
  error,
}: {
  rows: PlayerBlkRow[];
  loading: boolean;
  error: string | null;
}) {
  const COLS = 7;
  return (
    <div className="overflow-x-auto rounded-lg border border-white/10">
      <table className="w-full text-sm">
        <thead className="bg-white/5">
          <tr>
            <Th>Player</Th>
            <Th>Date</Th>
            <Th>Opp</Th>
            <Th>H/A</Th>
            <Th>BLK</Th>
            <Th>TOI</Th>
            <Th>Fetched</Th>
          </tr>
        </thead>
        <tbody className="divide-y divide-white/5">
          {loading ? (
            <LoadingRow cols={COLS} />
          ) : error ? (
            <ErrorRow cols={COLS} msg={error} />
          ) : rows.length === 0 ? (
            <EmptyRow cols={COLS} />
          ) : (
            rows.map((r) => (
              <tr key={r.id} className="hover:bg-white/5">
                <td className="px-3 py-2 font-medium text-cloud">
                  {r.player_name ?? `#${r.player_id}`}
                </td>
                <td className="px-3 py-2 text-cloud/70">{r.game_date ?? '—'}</td>
                <td className="px-3 py-2 text-cloud/70">{r.opponent ?? '—'}</td>
                <td className="px-3 py-2 text-cloud/50">
                  {r.is_home ? 'H' : 'A'}
                </td>
                <td className="px-3 py-2 text-right font-mono font-semibold text-purple-300">
                  {num(r.blocked_shots)}
                </td>
                <td className="px-3 py-2 text-right font-mono text-cloud/60">
                  {r.toi_minutes != null ? r.toi_minutes.toFixed(1) : '—'}
                </td>
                <td className="px-3 py-2 text-right text-cloud/40 text-xs">
                  {formatAge(r.fetched_at)}
                </td>
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}

// ── Pitcher Ks Table ───────────────────────────────────────────────────────

function PitcherKsTable({
  rows,
  loading,
  error,
}: {
  rows: PitcherKRow[];
  loading: boolean;
  error: string | null;
}) {
  const COLS = 9;
  return (
    <div className="overflow-x-auto rounded-lg border border-white/10">
      <table className="w-full text-sm">
        <thead className="bg-white/5">
          <tr>
            <Th>Pitcher</Th>
            <Th>Team</Th>
            <Th>Date</Th>
            <Th>Opp</Th>
            <Th>H/A</Th>
            <Th>K</Th>
            <Th>IP</Th>
            <Th>BB</Th>
            <Th>ER</Th>
          </tr>
        </thead>
        <tbody className="divide-y divide-white/5">
          {loading ? (
            <LoadingRow cols={COLS} />
          ) : error ? (
            <ErrorRow cols={COLS} msg={error} />
          ) : rows.length === 0 ? (
            <EmptyRow cols={COLS} />
          ) : (
            rows.map((r) => (
              <tr key={r.id} className="hover:bg-white/5">
                <td className="px-3 py-2 font-medium text-cloud">
                  {r.full_name ?? `#${r.mlb_pitcher_id}`}
                </td>
                <td className="px-3 py-2 text-cloud/60">{r.team ?? '—'}</td>
                <td className="px-3 py-2 text-cloud/70">{r.game_date}</td>
                <td className="px-3 py-2 text-cloud/70">{r.opponent ?? '—'}</td>
                <td className="px-3 py-2 text-cloud/50">
                  {r.home_away ? (r.home_away === 'home' ? 'H' : 'A') : '—'}
                </td>
                <td className="px-3 py-2 text-right font-mono font-semibold text-green-300">
                  {num(r.strikeouts)}
                </td>
                <td className="px-3 py-2 text-right font-mono text-cloud/60">
                  {ip(r.innings_pitched)}
                </td>
                <td className="px-3 py-2 text-right font-mono text-cloud/60">
                  {num(r.walks)}
                </td>
                <td className="px-3 py-2 text-right font-mono text-cloud/60">
                  {num(r.earned_runs)}
                </td>
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}

// ── Date Picker ────────────────────────────────────────────────────────────

function DateFilter({
  date,
  onChange,
}: {
  date: string;
  onChange: (v: string) => void;
}) {
  return (
    <div className="flex items-center gap-2">
      <label className="text-xs text-cloud/50 uppercase tracking-wide">Date</label>
      <input
        type="date"
        value={date}
        onChange={(e) => onChange(e.target.value)}
        className="rounded border border-white/20 bg-white/5 px-2 py-1 text-sm text-cloud focus:border-white/40 focus:outline-none"
      />
      {date && (
        <button
          onClick={() => onChange('')}
          className="text-xs text-cloud/40 hover:text-cloud/70"
        >
          Clear
        </button>
      )}
    </div>
  );
}

// ── Main Page ──────────────────────────────────────────────────────────────

export default function PropsFeedClient() {
  const today = new Date().toISOString().slice(0, 10);

  const [shotsDate, setShotsDate] = useState(today);
  const [blkDate, setBlkDate] = useState(today);
  const [ksDate, setKsDate] = useState(today);

  const [shotsRows, setShotsRows] = useState<PlayerShotRow[]>([]);
  const [blkRows, setBlkRows] = useState<PlayerBlkRow[]>([]);
  const [ksRows, setKsRows] = useState<PitcherKRow[]>([]);

  const [shotsLoading, setShotsLoading] = useState(true);
  const [blkLoading, setBlkLoading] = useState(true);
  const [ksLoading, setKsLoading] = useState(true);

  const [shotsError, setShotsError] = useState<string | null>(null);
  const [blkError, setBlkError] = useState<string | null>(null);
  const [ksError, setKsError] = useState<string | null>(null);

  const [lastRefresh, setLastRefresh] = useState<Date | null>(null);

  const fetchShots = useCallback(async (date: string) => {
    setShotsLoading(true);
    setShotsError(null);
    try {
      const params = new URLSearchParams({ limit: '200' });
      if (date) params.set('date', date);
      const res = await fetch(`/api/props/player-shots?${params}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      setShotsRows(json.data ?? []);
    } catch (e) {
      setShotsError(e instanceof Error ? e.message : 'Failed to load');
    } finally {
      setShotsLoading(false);
    }
  }, []);

  const fetchBlk = useCallback(async (date: string) => {
    setBlkLoading(true);
    setBlkError(null);
    try {
      const params = new URLSearchParams({ limit: '200' });
      if (date) params.set('date', date);
      const res = await fetch(`/api/props/player-blk?${params}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      setBlkRows(json.data ?? []);
    } catch (e) {
      setBlkError(e instanceof Error ? e.message : 'Failed to load');
    } finally {
      setBlkLoading(false);
    }
  }, []);

  const fetchKs = useCallback(async (date: string) => {
    setKsLoading(true);
    setKsError(null);
    try {
      const params = new URLSearchParams({ limit: '200' });
      if (date) params.set('date', date);
      const res = await fetch(`/api/props/pitcher-ks?${params}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      setKsRows(json.data ?? []);
    } catch (e) {
      setKsError(e instanceof Error ? e.message : 'Failed to load');
    } finally {
      setKsLoading(false);
    }
  }, []);

  // Initial load
  useEffect(() => {
    fetchShots(shotsDate);
  }, [fetchShots, shotsDate]);

  useEffect(() => {
    fetchBlk(blkDate);
  }, [fetchBlk, blkDate]);

  useEffect(() => {
    fetchKs(ksDate);
  }, [fetchKs, ksDate]);

  const handleRefreshAll = useCallback(() => {
    fetchShots(shotsDate);
    fetchBlk(blkDate);
    fetchKs(ksDate);
    setLastRefresh(new Date());
  }, [fetchShots, fetchBlk, fetchKs, shotsDate, blkDate, ksDate]);

  return (
    <div className="min-h-screen bg-night px-4 py-8 text-cloud">
      {/* Header */}
      <div className="mx-auto max-w-7xl">
        <div className="mb-8 flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold text-cloud">Props Feed</h1>
            <p className="mt-1 text-sm text-cloud/50">
              NHL shots · NHL blocked shots · MLB pitcher strikeouts
            </p>
          </div>
          <div className="flex items-center gap-4">
            {lastRefresh && (
              <span className="text-xs text-cloud/40">
                Refreshed {formatAge(lastRefresh.toISOString())}
              </span>
            )}
            <button
              onClick={handleRefreshAll}
              className="rounded border border-white/20 bg-white/5 px-3 py-1.5 text-sm text-cloud hover:bg-white/10"
            >
              Refresh all
            </button>
          </div>
        </div>

        <div className="space-y-10">
          {/* NHL Shots */}
          <section>
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-lg font-semibold text-blue-300">
                NHL Player Shots
                {!shotsLoading && (
                  <span className="ml-2 text-sm font-normal text-cloud/40">
                    ({shotsRows.length} rows)
                  </span>
                )}
              </h2>
              <DateFilter date={shotsDate} onChange={setShotsDate} />
            </div>
            <ShotsTable rows={shotsRows} loading={shotsLoading} error={shotsError} />
          </section>

          {/* NHL Blocked Shots */}
          <section>
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-lg font-semibold text-purple-300">
                NHL Blocked Shots
                {!blkLoading && (
                  <span className="ml-2 text-sm font-normal text-cloud/40">
                    ({blkRows.length} rows)
                  </span>
                )}
              </h2>
              <DateFilter date={blkDate} onChange={setBlkDate} />
            </div>
            <BlkTable rows={blkRows} loading={blkLoading} error={blkError} />
          </section>

          {/* MLB Pitcher Ks */}
          <section>
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-lg font-semibold text-green-300">
                MLB Pitcher Strikeouts
                {!ksLoading && (
                  <span className="ml-2 text-sm font-normal text-cloud/40">
                    ({ksRows.length} rows)
                  </span>
                )}
              </h2>
              <DateFilter date={ksDate} onChange={setKsDate} />
            </div>
            <PitcherKsTable rows={ksRows} loading={ksLoading} error={ksError} />
          </section>
        </div>
      </div>
    </div>
  );
}
