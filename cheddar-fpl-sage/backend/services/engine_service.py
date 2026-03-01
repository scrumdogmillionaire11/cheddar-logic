"""
Engine service - bridges FastAPI to existing CLI decision framework.
"""
import logging
import json
from typing import Dict, Optional, Any, Callable, List
from datetime import datetime, timezone
import uuid
import asyncio
from pathlib import Path
import os

# Import existing engine
from cheddar_fpl_sage.analysis.fpl_sage_integration import FPLSageIntegration

# Import result transformer
from backend.services.result_transformer import transform_analysis_results

logger = logging.getLogger(__name__)

# Get paths relative to project root (backend is one level down)
PROJECT_ROOT = Path(__file__).parent.parent.parent
CONFIG_FILE = PROJECT_ROOT / "config" / "team_config.json"

# Set working directory to project root for ruleset loading
# This ensures relative paths like "config/rulesets/" work correctly
os.chdir(PROJECT_ROOT)


class AnalysisJob:
    """Represents a running or completed analysis job."""
    
    def __init__(self, analysis_id: str, team_id: int, gameweek: Optional[int] = None, overrides: Optional[Dict] = None):
        self.analysis_id = analysis_id
        self.team_id = team_id
        self.gameweek = gameweek
        self.overrides = overrides or {}
        self.status = "queued"
        self.progress = 0.0
        self.phase: Optional[str] = None
        self.results: Optional[Dict] = None
        self.error: Optional[str] = None
        self.created_at = datetime.now(timezone.utc)
        self.completed_at: Optional[datetime] = None

    def to_dict(self) -> Dict[str, Any]:
        """Serialize job to a JSON-friendly dictionary."""
        return {
            "analysis_id": self.analysis_id,
            "team_id": self.team_id,
            "gameweek": self.gameweek,
            "overrides": self.overrides,
            "status": self.status,
            "progress": self.progress,
            "phase": self.phase,
            "results": self.results,
            "error": self.error,
            "created_at": self.created_at.isoformat(),
            "completed_at": self.completed_at.isoformat() if self.completed_at else None,
        }

    @classmethod
    def from_dict(cls, payload: Dict[str, Any]) -> "AnalysisJob":
        """Deserialize persisted job payload."""
        job = cls(
            analysis_id=payload["analysis_id"],
            team_id=int(payload["team_id"]),
            gameweek=payload.get("gameweek"),
            overrides=payload.get("overrides"),
        )
        job.status = payload.get("status", "queued")
        job.progress = float(payload.get("progress", 0.0) or 0.0)
        job.phase = payload.get("phase")
        job.results = payload.get("results")
        job.error = payload.get("error")
        created_at = payload.get("created_at")
        completed_at = payload.get("completed_at")
        if created_at:
            job.created_at = datetime.fromisoformat(created_at)
        if completed_at:
            job.completed_at = datetime.fromisoformat(completed_at)
        return job


class EngineService:
    """
    Service layer that invokes the existing FPL Sage decision engine.
    Manages analysis jobs and provides progress callbacks.
    """

    def __init__(self):
        self._jobs: Dict[str, AnalysisJob] = {}  # In-memory job storage for MVP
        self._progress_callbacks: Dict[str, List[Callable]] = {}
        self._redis = None
        self._job_ttl_seconds = 7 * 24 * 3600

    def configure_redis(self, redis_client=None, job_ttl_seconds: int = 604800) -> None:
        """Configure optional Redis-backed persistence for analysis jobs."""
        self._redis = redis_client
        self._job_ttl_seconds = max(3600, job_ttl_seconds)

    @staticmethod
    def _job_key(analysis_id: str) -> str:
        return f"fpl_sage:job:{analysis_id}"

    def _persist_job(self, job: AnalysisJob) -> None:
        """Persist job state to Redis when available."""
        if not self._redis:
            return
        try:
            payload = json.dumps(job.to_dict(), default=str)
            self._redis.setex(self._job_key(job.analysis_id), self._job_ttl_seconds, payload)
        except Exception as exc:
            logger.warning("Failed to persist analysis job state: %s", exc)

    def _load_job_from_redis(self, analysis_id: str) -> Optional[AnalysisJob]:
        """Load job from Redis fallback storage."""
        if not self._redis:
            return None
        try:
            raw = self._redis.get(self._job_key(analysis_id))
            if not raw:
                return None
            payload = json.loads(raw)
            return AnalysisJob.from_dict(payload)
        except Exception as exc:
            logger.warning("Failed to load analysis job state: %s", exc)
            return None

    def create_analysis(self, team_id: int, gameweek: Optional[int] = None, overrides: Optional[Dict] = None) -> AnalysisJob:
        """Create a new analysis job."""
        analysis_id = str(uuid.uuid4())
        job = AnalysisJob(analysis_id, team_id, gameweek, overrides)
        self._jobs[analysis_id] = job
        self._progress_callbacks[analysis_id] = []
        self._persist_job(job)
        return job

    def get_job(self, analysis_id: str) -> Optional[AnalysisJob]:
        """Get job by ID."""
        cached = self._jobs.get(analysis_id)
        if cached:
            return cached
        restored = self._load_job_from_redis(analysis_id)
        if restored:
            self._jobs[analysis_id] = restored
            self._progress_callbacks.setdefault(analysis_id, [])
        return restored

    def register_progress_callback(self, analysis_id: str, callback: Callable[[float, str], None]):
        """
        Register a callback for progress updates.

        Callback signature: (progress: float, phase: str) -> None
        """
        if analysis_id not in self._progress_callbacks:
            self._progress_callbacks[analysis_id] = []
        self._progress_callbacks[analysis_id].append(callback)
        logger.debug(f"Registered progress callback for {analysis_id}")

    def _notify_progress(self, analysis_id: str, progress: float, phase: str):
        """Notify all registered callbacks of progress."""
        job = self._jobs.get(analysis_id)
        if job:
            job.progress = progress
            job.phase = phase
            self._persist_job(job)

        callbacks = self._progress_callbacks.get(analysis_id, [])
        for callback in callbacks:
            try:
                callback(progress, phase)
            except Exception as e:
                logger.warning(f"Progress callback failed: {e}")

    def _cleanup_job(self, analysis_id: str):
        """Clean up callbacks after job completes (keeps job for retrieval)."""
        if analysis_id in self._progress_callbacks:
            del self._progress_callbacks[analysis_id]

    @staticmethod
    def _job_user_id(job: AnalysisJob) -> Optional[str]:
        user_id = (job.overrides or {}).get("user_id")
        if user_id is None:
            return None
        value = str(user_id).strip()
        return value or None

    @staticmethod
    def _extract_season(job: AnalysisJob) -> Optional[str]:
        if not isinstance(job.results, dict):
            return None
        direct = job.results.get("season")
        if isinstance(direct, str) and direct.strip():
            return direct.strip()
        summary = job.results.get("summary")
        if isinstance(summary, dict):
            nested = summary.get("season")
            if isinstance(nested, str) and nested.strip():
                return nested.strip()
        return None

    @staticmethod
    def _safe_float(value: Any, default: float = 0.0) -> float:
        try:
            return float(value)
        except (TypeError, ValueError):
            return default

    def _extract_team_gw_points(self, results: Dict[str, Any]) -> Optional[float]:
        """Extract team GW points from transformed results when available."""
        direct = results.get("current_points")
        if direct is not None:
            return self._safe_float(direct)

        direct = results.get("points_this_gw")
        if direct is not None:
            return self._safe_float(direct)

        summary = results.get("summary", {})
        if isinstance(summary, dict):
            summary_points = summary.get("current_points")
            if summary_points is not None:
                return self._safe_float(summary_points)

        # Fallback: approximate from season total / current GW when both are present
        total_points = results.get("overall_points")
        current_gw = results.get("current_gw")
        if total_points is not None and current_gw:
            gw = int(current_gw)
            if gw > 0:
                return round(self._safe_float(total_points) / gw, 2)
        return None

    def _extract_fpl_average_gw_points(self, results: Dict[str, Any]) -> Optional[float]:
        """Extract FPL average GW points from available fields."""
        candidates = [
            results.get("fpl_average_gw_points"),
            results.get("average_entry_score"),
            results.get("gw_average_points"),
        ]
        summary = results.get("summary", {})
        if isinstance(summary, dict):
            candidates.append(summary.get("fpl_average_gw_points"))

        for value in candidates:
            if value is not None:
                return self._safe_float(value)
        return None

    def _build_recommendation_summary(self, job: AnalysisJob) -> str:
        results = job.results if isinstance(job.results, dict) else {}
        summary = results.get("summary", {})
        if isinstance(summary, dict):
            total = summary.get("total_transfers_recommended")
            urgent = summary.get("urgent_transfers")
            if total is not None or urgent is not None:
                return f"{int(total or 0)} transfers recommended, {int(urgent or 0)} urgent"

        transfers = results.get("transfer_recommendations", [])
        transfer_count = len(transfers) if isinstance(transfers, list) else 0
        if transfer_count:
            return f"{transfer_count} transfer recommendations"
        return "No transfer recommendations"

    def _build_captain_summary(self, job: AnalysisJob) -> str:
        results = job.results if isinstance(job.results, dict) else {}
        captain_block = results.get("captain_recommendation")
        if isinstance(captain_block, dict):
            primary = captain_block.get("primary")
            if isinstance(primary, dict):
                name = primary.get("player_name")
                pts = primary.get("expected_points")
                if name and pts is not None:
                    return f"{name} ({self._safe_float(pts):.1f} pts)"
                if name:
                    return str(name)

        captaincy = results.get("captaincy")
        if isinstance(captaincy, dict):
            captain = captaincy.get("captain")
            if isinstance(captain, dict):
                name = captain.get("name")
                pts = captain.get("expected_pts") or captain.get("nextGW_pts")
                if name and pts is not None:
                    return f"{name} ({self._safe_float(pts):.1f} pts)"
                if name:
                    return str(name)
        return "N/A"

    def list_user_analyses(
        self,
        user_id: str,
        limit: int = 20,
        offset: int = 0,
        season: Optional[str] = None,
        sort_by: str = "created_at",
    ) -> Dict[str, Any]:
        """List stored analyses for a user from local job state."""
        normalized_user_id = str(user_id).strip()
        jobs = [job for job in self._jobs.values() if self._job_user_id(job) == normalized_user_id]

        if season:
            jobs = [job for job in jobs if self._extract_season(job) == season]

        total = len(jobs)
        if sort_by == "gameweek":
            jobs.sort(
                key=lambda job: ((job.gameweek if isinstance(job.gameweek, int) else -1), job.created_at),
                reverse=True,
            )
        else:
            jobs.sort(key=lambda job: job.created_at, reverse=True)

        selected = jobs[offset: offset + limit]
        analyses = []
        for job in selected:
            analyses.append(
                {
                    "analysis_id": job.analysis_id,
                    "gameweek": job.gameweek,
                    "created_at": job.created_at.isoformat(),
                    "team_id": job.team_id,
                    "recommendation_summary": self._build_recommendation_summary(job),
                    "captain": self._build_captain_summary(job),
                    "status": job.status,
                }
            )

        return {
            "user_id": normalized_user_id,
            "total": total,
            "analyses": analyses,
        }

    def get_user_performance(
        self,
        user_id: str,
        season: Optional[str] = None,
        include_details: bool = False,
    ) -> Dict[str, Any]:
        """Aggregate performance stats from completed analyses for a user."""
        normalized_user_id = str(user_id).strip()
        jobs = [job for job in self._jobs.values() if self._job_user_id(job) == normalized_user_id]
        if season:
            jobs = [job for job in jobs if self._extract_season(job) == season]

        completed = [job for job in jobs if str(job.status).lower() in {"complete", "completed"}]
        analyses_completed = len(completed)

        total_points = 0.0
        captain_predictions = 0
        captain_correct = 0
        recommended_transfers = 0
        acted_on_transfers = 0
        bench_boost_used = 0
        bench_boost_gain_sum = 0.0
        triple_captain_used = 0
        triple_captain_gain_sum = 0.0
        your_gw_points_samples: List[float] = []
        fpl_avg_points_samples: List[float] = []

        details: List[Dict[str, Any]] = []
        for job in completed:
            results = job.results if isinstance(job.results, dict) else {}
            summary = results.get("summary", {}) if isinstance(results.get("summary", {}), dict) else {}
            points = self._safe_float(
                summary.get("expected_team_points_improvement", summary.get("points_from_recommendations", 0.0))
            )
            total_points += points

            transfer_recs = results.get("transfer_recommendations", [])
            if isinstance(transfer_recs, list):
                recommended_transfers += len(transfer_recs)

            manual_transfers = (job.overrides or {}).get("manual_transfers", [])
            if isinstance(manual_transfers, list):
                acted_on_transfers += len(manual_transfers)

            captain_block = results.get("captain_recommendation")
            if isinstance(captain_block, dict) and isinstance(captain_block.get("primary"), dict):
                captain_predictions += 1
                metrics = captain_block.get("metrics", {})
                if isinstance(metrics, dict) and metrics.get("correct") is True:
                    captain_correct += 1

            chip_strategy = results.get("chip_strategy", {})
            if isinstance(chip_strategy, dict):
                bb = chip_strategy.get("bench_boost", {})
                if isinstance(bb, dict) and bb.get("recommended") is True:
                    bench_boost_used += 1
                    bench_boost_gain_sum += self._safe_float(bb.get("expected_boost", bb.get("best_window_value", 0.0)))

                tc = chip_strategy.get("triple_captain", {})
                if isinstance(tc, dict) and tc.get("recommended") is True:
                    triple_captain_used += 1
                    triple_captain_gain_sum += self._safe_float(
                        tc.get("expected_boost", tc.get("best_window_value", 0.0))
                    )

            your_gw_points = self._extract_team_gw_points(results)
            fpl_avg_gw_points = self._extract_fpl_average_gw_points(results)
            if your_gw_points is not None:
                your_gw_points_samples.append(your_gw_points)
            if fpl_avg_gw_points is not None:
                fpl_avg_points_samples.append(fpl_avg_gw_points)

            if include_details:
                details.append(
                    {
                        "analysis_id": job.analysis_id,
                        "team_id": job.team_id,
                        "gameweek": job.gameweek,
                        "created_at": job.created_at.isoformat(),
                        "points_from_recommendations": round(points, 2),
                        "captain": self._build_captain_summary(job),
                        "your_gw_points": your_gw_points,
                        "fpl_average_gw_points": fpl_avg_gw_points,
                    }
                )

        avg_points = (total_points / analyses_completed) if analyses_completed else 0.0
        captain_accuracy_pct = ((captain_correct / captain_predictions) * 100.0) if captain_predictions else 0.0
        adoption_rate_pct = ((acted_on_transfers / recommended_transfers) * 100.0) if recommended_transfers else 0.0
        bench_boost_avg = (bench_boost_gain_sum / bench_boost_used) if bench_boost_used else 0.0
        triple_captain_avg = (triple_captain_gain_sum / triple_captain_used) if triple_captain_used else 0.0
        your_avg_gw_points = (
            round(sum(your_gw_points_samples) / len(your_gw_points_samples), 2)
            if your_gw_points_samples
            else None
        )
        fpl_avg_gw_points = (
            round(sum(fpl_avg_points_samples) / len(fpl_avg_points_samples), 2)
            if fpl_avg_points_samples
            else None
        )
        outperformance_pct = None
        if your_avg_gw_points is not None and fpl_avg_gw_points is not None and fpl_avg_gw_points > 0:
            outperformance_pct = round(((your_avg_gw_points - fpl_avg_gw_points) / fpl_avg_gw_points) * 100.0, 1)

        response = {
            "user_id": normalized_user_id,
            "season": season or "current",
            "analyses_completed": analyses_completed,
            "total_points_from_recommendations": round(total_points, 2),
            "average_points_per_analysis": round(avg_points, 2),
            "captain_accuracy": {
                "correct_predictions": captain_correct,
                "total_predictions": captain_predictions,
                "accuracy_pct": round(captain_accuracy_pct, 1),
            },
            "transfer_quality": {
                "avg_points_gained_per_transfer": round(
                    (total_points / recommended_transfers) if recommended_transfers else 0.0, 2
                ),
                "recommended_transfers": recommended_transfers,
                "acted_on_transfers": acted_on_transfers,
                "adoption_rate_pct": round(adoption_rate_pct, 1),
            },
            "chip_strategy": {
                "benchboost_used": bench_boost_used,
                "benchboost_avg_gain": round(bench_boost_avg, 2),
                "triple_captain_used": triple_captain_used,
                "triple_captain_avg_gain": round(triple_captain_avg, 2),
            },
            "vs_average_team": {
                "your_avg_gw_points": your_avg_gw_points,
                "fpl_average_gw_points": fpl_avg_gw_points,
                "outperformance_pct": outperformance_pct,
            },
        }
        if include_details:
            response["details"] = details
        return response

    async def run_analysis(self, analysis_id: str, overrides: Optional[Dict] = None) -> Dict[str, Any]:
        """
        Run the analysis for a given job.
        This wraps the existing FPLSageIntegration.run_full_analysis().
        
        Args:
            analysis_id: Job identifier
            overrides: Optional manual overrides (chips, transfers, injuries)
        """
        job = self._jobs.get(analysis_id)
        if not job:
            raise ValueError(f"Job {analysis_id} not found")

        # Merge overrides from job creation and runtime
        final_overrides = {**job.overrides, **(overrides or {})}

        job.status = "analyzing"
        self._notify_progress(analysis_id, 2, "initializing")

        try:
            # Create integration with team ID and config file
            logger.info("Initializing FPLSageIntegration for analysis %s", analysis_id)
            sage = FPLSageIntegration(team_id=job.team_id, config_file=str(CONFIG_FILE))

            # Progress phases aligned to external API contract.
            self._notify_progress(analysis_id, 15, "data_collection")
            await asyncio.sleep(0.1)  # Yield to event loop

            self._notify_progress(analysis_id, 30, "injury_analysis")
            await asyncio.sleep(0.1)

            self._notify_progress(analysis_id, 55, "transfer_optimization")

            # Run the actual analysis with overrides
            results = await sage.run_full_analysis(save_data=False, overrides=final_overrides)
            
            # Tag results with what overrides were applied (for debugging)
            if final_overrides:
                results["_overrides_applied"] = final_overrides

            self._notify_progress(analysis_id, 72, "chip_strategy")
            self._notify_progress(analysis_id, 86, "captain_analysis")
            self._notify_progress(analysis_id, 95, "finalization")
            await asyncio.sleep(0.1)

            # Transform results for frontend
            transformed_results = transform_analysis_results(results, overrides=final_overrides)

            self._notify_progress(analysis_id, 100, "finalization")

            job.status = "complete"
            job.results = transformed_results
            job.completed_at = datetime.now(timezone.utc)
            self._persist_job(job)

            return transformed_results

        except Exception as e:
            logger.exception(f"Analysis failed for job {analysis_id}")
            job.status = "failed"
            job.error = str(e)
            job.completed_at = datetime.now(timezone.utc)
            self._persist_job(job)
            self._notify_progress(analysis_id, max(job.progress, 1.0), "finalization")
            raise
        finally:
            # Don't cleanup immediately - allow WebSocket to get final state
            # Cleanup will happen when job expires (not implemented yet for MVP)
            pass


# Singleton instance
engine_service = EngineService()
