"""Durable product store for FPL Sage.

WI-0652: Product-store foundation.

Persists manager profiles, draft sessions, parsed squads, draft audits,
draft candidates, and decision receipts.

IMPORTANT: This store is entirely separate from the transient Redis/
analysis-job cache managed by cache_service and engine_service.
Do NOT access Redis here and do NOT move weekly-analysis job state into
this store.
"""
from __future__ import annotations

import json
import logging
import os
from datetime import datetime, timezone
from pathlib import Path
from threading import Lock
from typing import Dict, List, Optional

from backend.models.product_models import (
    DecisionReceipt,
    DraftAudit,
    DraftCandidate,
    DraftSession,
    ManagerProfile,
    ParsedSquad,
)

logger = logging.getLogger(__name__)

# ── Default on-disk store path ────────────────────────────────────────────────
# Override via SAGE_PRODUCT_STORE_PATH env var.
_DEFAULT_STORE_DIR = Path(__file__).parent.parent / "outputs"
_DEFAULT_STORE_PATH = os.environ.get(
    "SAGE_PRODUCT_STORE_PATH",
    str(_DEFAULT_STORE_DIR / "product_store.json"),
)


class ProductStore:
    """File-backed in-memory document store for Sage product entities.

    Collections are plain dicts keyed by primary-ID string.
    Writes are serialised via a threading.Lock and atomically flushed
    to disk (write-to-tmp then rename) after every mutation.

    Usage::

        from backend.services.product_store import product_store

        product_store.initialize()           # called once at app startup
        profile = product_store.upsert_profile(...)
    """

    def __init__(self, store_path: Optional[str] = None) -> None:
        self._path = Path(store_path or _DEFAULT_STORE_PATH)
        self._lock = Lock()
        self._collections: Dict[str, Dict[str, dict]] = {
            "manager_profiles": {},
            "draft_sessions": {},
            "draft_candidates": {},
            "parsed_squads": {},
            "draft_audits": {},
            "decision_receipts": {},
        }
        self._initialized = False

    # ── Lifecycle ─────────────────────────────────────────────────────────────

    def initialize(self) -> None:
        """Load persisted state from disk, or create a fresh empty store.

        Safe to call multiple times (idempotent after first call).
        """
        if self._initialized:
            return
        try:
            if self._path.exists():
                with self._path.open("r", encoding="utf-8") as fh:
                    data = json.load(fh)
                with self._lock:
                    for key in self._collections:
                        self._collections[key] = data.get(key, {})
                logger.info("ProductStore loaded from %s", self._path)
            else:
                self._path.parent.mkdir(parents=True, exist_ok=True)
                with self._lock:
                    self._flush_unlocked()
                logger.info("ProductStore initialised (empty) at %s", self._path)
            self._initialized = True
        except Exception as exc:  # pragma: no cover
            logger.warning("ProductStore init warning (%s); starting with empty in-memory store.", exc)
            self._initialized = True

    def _flush_unlocked(self) -> None:
        """Write current collections to disk.  Must be called while _lock is held."""
        try:
            self._path.parent.mkdir(parents=True, exist_ok=True)
            tmp = self._path.with_suffix(".tmp")
            with tmp.open("w", encoding="utf-8") as fh:
                json.dump(self._collections, fh, indent=2, default=str)
            tmp.replace(self._path)
        except Exception as exc:
            logger.warning("ProductStore flush failed: %s", exc)

    def health(self) -> dict:
        """Return basic diagnostics (counts per collection, store path)."""
        return {
            "initialized": self._initialized,
            "store_path": str(self._path),
            "counts": {k: len(v) for k, v in self._collections.items()},
        }

    # ── Manager Profiles ──────────────────────────────────────────────────────

    def upsert_profile(self, profile: ManagerProfile) -> ManagerProfile:
        """Insert or update a manager profile (keyed by manager_id)."""
        with self._lock:
            profile.updated_at = datetime.now(timezone.utc)
            self._collections["manager_profiles"][profile.manager_id] = profile.model_dump(mode="json")
            self._flush_unlocked()
        return profile

    def get_profile(self, manager_id: str) -> Optional[ManagerProfile]:
        """Return a profile by its Sage-internal manager_id, or None."""
        row = self._collections["manager_profiles"].get(manager_id)
        return ManagerProfile.model_validate(row) if row else None

    def get_profile_by_fpl_team_id(self, fpl_team_id: int) -> Optional[ManagerProfile]:
        """Return a profile by FPL entry ID, or None."""
        for row in self._collections["manager_profiles"].values():
            if row.get("fpl_team_id") == fpl_team_id:
                return ManagerProfile.model_validate(row)
        return None

    def list_profiles(self) -> List[ManagerProfile]:
        """Return all stored manager profiles."""
        return [ManagerProfile.model_validate(r) for r in self._collections["manager_profiles"].values()]

    # ── Draft Sessions ────────────────────────────────────────────────────────

    def create_session(self, session: DraftSession) -> DraftSession:
        """Persist a new draft session (or overwrite by session_id)."""
        with self._lock:
            self._collections["draft_sessions"][session.session_id] = session.model_dump(mode="json")
            self._flush_unlocked()
        return session

    def get_session(self, session_id: str) -> Optional[DraftSession]:
        row = self._collections["draft_sessions"].get(session_id)
        return DraftSession.model_validate(row) if row else None

    def update_session(self, session: DraftSession) -> DraftSession:
        """Update an existing session in place."""
        return self.create_session(session)

    def list_sessions(self, manager_id: Optional[str] = None) -> List[DraftSession]:
        rows = list(self._collections["draft_sessions"].values())
        if manager_id is not None:
            rows = [r for r in rows if r.get("manager_id") == manager_id]
        return [DraftSession.model_validate(r) for r in rows]

    # ── Draft Candidates ──────────────────────────────────────────────────────

    def add_candidate(self, candidate: DraftCandidate) -> DraftCandidate:
        with self._lock:
            self._collections["draft_candidates"][candidate.candidate_id] = candidate.model_dump(mode="json")
            self._flush_unlocked()
        return candidate

    def get_candidate(self, candidate_id: str) -> Optional[DraftCandidate]:
        row = self._collections["draft_candidates"].get(candidate_id)
        return DraftCandidate.model_validate(row) if row else None

    def list_candidates(self, session_id: Optional[str] = None) -> List[DraftCandidate]:
        rows = list(self._collections["draft_candidates"].values())
        if session_id is not None:
            rows = [r for r in rows if r.get("session_id") == session_id]
        return [DraftCandidate.model_validate(r) for r in rows]

    # ── Parsed Squads ─────────────────────────────────────────────────────────

    def save_squad(self, squad: ParsedSquad) -> ParsedSquad:
        with self._lock:
            self._collections["parsed_squads"][squad.squad_id] = squad.model_dump(mode="json")
            self._flush_unlocked()
        return squad

    def get_squad(self, squad_id: str) -> Optional[ParsedSquad]:
        row = self._collections["parsed_squads"].get(squad_id)
        return ParsedSquad.model_validate(row) if row else None

    def list_squads(self, session_id: Optional[str] = None) -> List[ParsedSquad]:
        rows = list(self._collections["parsed_squads"].values())
        if session_id is not None:
            rows = [r for r in rows if r.get("session_id") == session_id]
        return [ParsedSquad.model_validate(r) for r in rows]

    # ── Draft Audits ──────────────────────────────────────────────────────────

    def append_audit(self, audit: DraftAudit) -> DraftAudit:
        """Append an immutable audit event (keyed by audit_id)."""
        with self._lock:
            self._collections["draft_audits"][audit.audit_id] = audit.model_dump(mode="json")
            self._flush_unlocked()
        return audit

    def list_audits(self, session_id: Optional[str] = None) -> List[DraftAudit]:
        rows = list(self._collections["draft_audits"].values())
        if session_id is not None:
            rows = [r for r in rows if r.get("session_id") == session_id]
        return [DraftAudit.model_validate(r) for r in rows]

    # ── Decision Receipts ─────────────────────────────────────────────────────

    def save_receipt(self, receipt: DecisionReceipt) -> DecisionReceipt:
        with self._lock:
            self._collections["decision_receipts"][receipt.receipt_id] = receipt.model_dump(mode="json")
            self._flush_unlocked()
        return receipt

    def get_receipt(self, receipt_id: str) -> Optional[DecisionReceipt]:
        row = self._collections["decision_receipts"].get(receipt_id)
        return DecisionReceipt.model_validate(row) if row else None

    def list_receipts(
        self,
        session_id: Optional[str] = None,
        manager_id: Optional[str] = None,
    ) -> List[DecisionReceipt]:
        rows = list(self._collections["decision_receipts"].values())
        if session_id is not None:
            rows = [r for r in rows if r.get("session_id") == session_id]
        if manager_id is not None:
            rows = [r for r in rows if r.get("manager_id") == manager_id]
        return [DecisionReceipt.model_validate(r) for r in rows]


# ── Module-level singleton ────────────────────────────────────────────────────
# Import and call `product_store.initialize()` in lifespan; everywhere else
# just import and use directly.
product_store = ProductStore()
