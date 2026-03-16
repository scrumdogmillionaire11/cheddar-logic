# tracking/win_rate_tracker.py
# System B performance tracking — win rate on recommended side only.
#
# Design:
#   - Log every ProjectionPlay with its recommended_side at time of generation
#   - After game completes, record actual_value
#   - Compute whether recommended_side was correct
#   - Track rolling win rate per (sport, prop_type)
#   - Flag models for recalibration when win rate drops below threshold
#
# Storage: SQLite (play_log.db) — lightweight, no server needed.
# Schema is created automatically on first run.

from __future__ import annotations
import sqlite3
import os
from datetime import datetime, timezone
from collections import defaultdict

from shared.constants import (
    WIN_RATE_RECAL_THRESHOLD,
    WIN_RATE_MIN_SAMPLE,
    System,
)

DB_PATH = os.path.join(os.path.dirname(__file__), "play_log.db")


# ── Database setup ─────────────────────────────────────────────────────────────

def _get_conn() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def init_db():
    """Create tables if they don't exist. Safe to call repeatedly."""
    with _get_conn() as conn:
        conn.executescript("""
            CREATE TABLE IF NOT EXISTS projection_plays (
                play_id          TEXT PRIMARY KEY,
                sport            TEXT NOT NULL,
                game             TEXT NOT NULL,
                player           TEXT NOT NULL,
                prop_type        TEXT NOT NULL,
                proj_value       REAL NOT NULL,
                floor            REAL NOT NULL,
                ceiling          REAL NOT NULL,
                recommended_side TEXT NOT NULL,
                confidence       TEXT NOT NULL,
                generated_at     TEXT NOT NULL,
                -- Filled in after game completes:
                actual_value     REAL,
                result           TEXT,   -- 'WIN' | 'LOSS' | 'PUSH' | 'VOID'
                graded_at        TEXT
            );

            CREATE TABLE IF NOT EXISTS edge_plays (
                play_id          TEXT PRIMARY KEY,
                sport            TEXT NOT NULL,
                game             TEXT NOT NULL,
                market_type      TEXT NOT NULL,
                pick             TEXT NOT NULL,
                edge_pct         REAL NOT NULL,
                tier             TEXT NOT NULL,
                kelly_stake      REAL NOT NULL,
                implied_prob     REAL NOT NULL,
                generated_at     TEXT NOT NULL,
                -- Filled in after game completes:
                result           TEXT,   -- 'WIN' | 'LOSS' | 'PUSH' | 'VOID'
                graded_at        TEXT
            );

            CREATE TABLE IF NOT EXISTS recalibration_flags (
                id               INTEGER PRIMARY KEY AUTOINCREMENT,
                sport            TEXT NOT NULL,
                prop_type        TEXT NOT NULL,
                win_rate         REAL NOT NULL,
                sample_size      INTEGER NOT NULL,
                flagged_at       TEXT NOT NULL,
                resolved         INTEGER DEFAULT 0   -- 0=open, 1=resolved
            );
        """)


# ── Log a projection play ──────────────────────────────────────────────────────

def log_projection_play(play) -> None:
    """
    Insert a new ProjectionPlay into projection_plays table.
    Called immediately after System B generates a play.
    """
    init_db()
    with _get_conn() as conn:
        conn.execute("""
            INSERT OR IGNORE INTO projection_plays
            (play_id, sport, game, player, prop_type, proj_value,
             floor, ceiling, recommended_side, confidence, generated_at)
            VALUES (?,?,?,?,?,?,?,?,?,?,?)
        """, (
            play.play_id, play.sport, play.game, play.player,
            play.prop_type, play.proj_value, play.floor, play.ceiling,
            play.recommended_side, play.confidence, play.generated_at,
        ))


# ── Grade a completed play ─────────────────────────────────────────────────────

def grade_projection(play_id: str, actual_value: float) -> str:
    """
    Grade a ProjectionPlay after the game completes.

    Args:
        play_id:      UUID of the play
        actual_value: The real stat result (e.g. 27.0 points)

    Returns:
        Result string: 'WIN' | 'LOSS' | 'PUSH' | 'VOID'
    """
    init_db()
    with _get_conn() as conn:
        row = conn.execute(
            "SELECT recommended_side, proj_value FROM projection_plays WHERE play_id=?",
            (play_id,)
        ).fetchone()

        if not row:
            raise ValueError(f"play_id not found: {play_id}")

        side = row["recommended_side"]
        proj = row["proj_value"]

        # Determine result
        # We don't have a line here — we're just checking if we called the right side
        # relative to actual. Proxy: did actual beat projection (OVER) or not (UNDER)?
        # This is intentionally simple — win rate on recommended side vs. outcome.
        if abs(actual_value - proj) < 0.5:
            result = "PUSH"
        elif side == "OVER" and actual_value > proj:
            result = "WIN"
        elif side == "UNDER" and actual_value < proj:
            result = "WIN"
        else:
            result = "LOSS"

        now = datetime.now(timezone.utc).isoformat()
        conn.execute("""
            UPDATE projection_plays
            SET actual_value=?, result=?, graded_at=?
            WHERE play_id=?
        """, (actual_value, result, now, play_id))

    # Check if this model needs recalibration after grading
    _check_recalibration(play_id)

    return result


# ── Win rate computation ───────────────────────────────────────────────────────

def get_win_rate(
    sport: str | None = None,
    prop_type: str | None = None,
    last_n: int = 50,
) -> dict:
    """
    Compute win rate for a given sport/prop_type combination.

    Args:
        sport:      Filter by sport (None = all)
        prop_type:  Filter by prop_type (None = all)
        last_n:     How many recent graded plays to include

    Returns:
        dict with keys: wins, losses, pushes, total, win_rate, sample_adequate
    """
    init_db()

    clauses = ["result IS NOT NULL", "result != 'VOID'"]
    params: list = []

    if sport:
        clauses.append("sport = ?")
        params.append(sport)
    if prop_type:
        clauses.append("prop_type = ?")
        params.append(prop_type)

    where = " AND ".join(clauses)

    with _get_conn() as conn:
        rows = conn.execute(f"""
            SELECT result FROM projection_plays
            WHERE {where}
            ORDER BY graded_at DESC
            LIMIT ?
        """, params + [last_n]).fetchall()

    results = [r["result"] for r in rows]
    wins   = results.count("WIN")
    losses = results.count("LOSS")
    pushes = results.count("PUSH")
    total  = wins + losses  # pushes excluded from win rate calc

    win_rate = (wins / total) if total > 0 else 0.0

    return {
        "wins": wins,
        "losses": losses,
        "pushes": pushes,
        "total": total,
        "win_rate": round(win_rate, 4),
        "win_rate_pct": round(win_rate * 100, 1),
        "sample_adequate": total >= WIN_RATE_MIN_SAMPLE,
    }


def get_win_rate_all_models() -> list[dict]:
    """Return win rate breakdown for every (sport, prop_type) combination."""
    init_db()
    with _get_conn() as conn:
        rows = conn.execute("""
            SELECT sport, prop_type, COUNT(*) as total,
                   SUM(CASE WHEN result='WIN' THEN 1 ELSE 0 END) as wins,
                   SUM(CASE WHEN result='LOSS' THEN 1 ELSE 0 END) as losses,
                   SUM(CASE WHEN result='PUSH' THEN 1 ELSE 0 END) as pushes
            FROM projection_plays
            WHERE result IS NOT NULL AND result != 'VOID'
            GROUP BY sport, prop_type
            ORDER BY sport, prop_type
        """).fetchall()

    results = []
    for row in rows:
        total = row["wins"] + row["losses"]
        win_rate = row["wins"] / total if total > 0 else 0.0
        results.append({
            "sport": row["sport"],
            "prop_type": row["prop_type"],
            "wins": row["wins"],
            "losses": row["losses"],
            "pushes": row["pushes"],
            "win_rate": round(win_rate, 4),
            "win_rate_pct": round(win_rate * 100, 1),
            "sample_adequate": total >= WIN_RATE_MIN_SAMPLE,
            "needs_recal": win_rate < WIN_RATE_RECAL_THRESHOLD and total >= WIN_RATE_MIN_SAMPLE,
        })
    return results


# ── Recalibration flag logic ───────────────────────────────────────────────────

def _check_recalibration(play_id: str) -> None:
    """
    After grading a play, check if its model's rolling win rate
    has dropped below the recalibration threshold. If so, log a flag.
    """
    with _get_conn() as conn:
        row = conn.execute(
            "SELECT sport, prop_type FROM projection_plays WHERE play_id=?",
            (play_id,)
        ).fetchone()
        if not row:
            return

    stats = get_win_rate(sport=row["sport"], prop_type=row["prop_type"], last_n=30)

    if (
        stats["sample_adequate"]
        and stats["win_rate"] < WIN_RATE_RECAL_THRESHOLD
    ):
        _log_recalibration_flag(
            sport=row["sport"],
            prop_type=row["prop_type"],
            win_rate=stats["win_rate"],
            sample_size=stats["total"],
        )


def _log_recalibration_flag(
    sport: str, prop_type: str, win_rate: float, sample_size: int
) -> None:
    """Insert a recalibration flag if one isn't already open for this model."""
    init_db()
    with _get_conn() as conn:
        existing = conn.execute("""
            SELECT id FROM recalibration_flags
            WHERE sport=? AND prop_type=? AND resolved=0
        """, (sport, prop_type)).fetchone()

        if not existing:
            now = datetime.now(timezone.utc).isoformat()
            conn.execute("""
                INSERT INTO recalibration_flags
                (sport, prop_type, win_rate, sample_size, flagged_at)
                VALUES (?,?,?,?,?)
            """, (sport, prop_type, win_rate, sample_size, now))
            print(
                f"[recalibration] ⚠️  FLAG: {sport} {prop_type} "
                f"win rate {win_rate*100:.1f}% over {sample_size} plays. "
                f"Model needs recalibration."
            )


def get_open_recalibration_flags() -> list[dict]:
    """Return all unresolved recalibration flags."""
    init_db()
    with _get_conn() as conn:
        rows = conn.execute("""
            SELECT sport, prop_type, win_rate, sample_size, flagged_at
            FROM recalibration_flags
            WHERE resolved=0
            ORDER BY flagged_at DESC
        """).fetchall()
    return [dict(r) for r in rows]


def resolve_flag(sport: str, prop_type: str) -> None:
    """Mark a recalibration flag as resolved after model is updated."""
    init_db()
    with _get_conn() as conn:
        conn.execute("""
            UPDATE recalibration_flags
            SET resolved=1
            WHERE sport=? AND prop_type=? AND resolved=0
        """, (sport, prop_type))
