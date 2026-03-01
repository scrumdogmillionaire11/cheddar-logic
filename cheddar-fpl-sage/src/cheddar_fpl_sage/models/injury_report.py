from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from enum import Enum
from typing import Any, Dict, List, Optional, Tuple


class InjuryStatus(Enum):
    FIT = "FIT"
    DOUBT = "DOUBTFUL"
    OUT = "OUT"
    UNKNOWN = "UNKNOWN"


class InjurySource(Enum):
    PRIMARY_FPL = "PRIMARY_FPL"
    SECONDARY_FEED = "SECONDARY_FEED"
    MANUAL_CONFIRMED = "MANUAL_CONFIRMED"
    UNKNOWN = "UNKNOWN"


class InjuryConfidence(Enum):
    HIGH = "HIGH"
    MED = "MED"
    LOW = "LOW"


@dataclass
class InjuryReport:
    player_id: int
    status: InjuryStatus
    chance: Optional[int] = None
    reason: Optional[str] = None
    source: InjurySource = InjurySource.UNKNOWN
    asof_utc: str = field(default_factory=lambda: datetime.now(timezone.utc).isoformat())
    confidence: InjuryConfidence = InjuryConfidence.HIGH

    def __post_init__(self):
        if isinstance(self.status, str):
            try:
                self.status = InjuryStatus[self.status]
            except KeyError:
                self.status = InjuryStatus.UNKNOWN
        if self.chance is not None:
            self.chance = max(0, min(100, int(self.chance)))

    def normalized_status(self) -> "InjuryReport":
        if self.status not in InjuryStatus:
            self.status = InjuryStatus.UNKNOWN
        if self.chance is not None:
            self.chance = max(0, min(100, int(self.chance)))
        return self

    def to_dict(self) -> Dict[str, Any]:
        return {
            "player_id": self.player_id,
            "status": self.status.value,
            "chance": self.chance,
            "reason": self.reason,
            "source": self.source.value,
            "asof_utc": self.asof_utc,
            "confidence": self.confidence.value,
        }

    @classmethod
    def from_dict(cls, payload: Dict[str, Any]) -> "InjuryReport":
        status_raw = payload.get("status") or payload.get("status_flag") or payload.get("status_label")
        status = InjuryStatus.UNKNOWN
        if isinstance(status_raw, str):
            status_key = status_raw.strip().upper()
            if status_key in InjuryStatus.__members__:
                status = InjuryStatus[status_key]
        source_raw = payload.get("source")
        source = InjurySource.UNKNOWN
        if isinstance(source_raw, str):
            key = source_raw.strip().upper()
            if key in InjurySource.__members__:
                source = InjurySource[key]
        confidence_raw = payload.get("confidence")
        confidence = InjuryConfidence.HIGH
        if isinstance(confidence_raw, str):
            key = confidence_raw.strip().upper()
            if key in InjuryConfidence.__members__:
                confidence = InjuryConfidence[key]
        asof = payload.get("asof_utc") or payload.get("asof") or datetime.now(timezone.utc).isoformat()
        reason = payload.get("reason") or payload.get("notes") or payload.get("injury_note")
        player_id = payload.get("player_id", -1)
        try:
            player_id = int(player_id)
        except Exception:
            player_id = -1
        chance = payload.get("chance") or payload.get("chance_of_playing_next_round")
        return cls(
            player_id=player_id,
            status=status,
            chance=chance,
            reason=reason,
            source=source,
            asof_utc=asof,
            confidence=confidence,
        )


MANUAL_EXPIRY_HOURS = 12
FPL_STALE_HOURS = 6
SECONDARY_STALE_HOURS = 8


def _parse_asof(report: InjuryReport) -> datetime:
    try:
        return datetime.fromisoformat(report.asof_utc).astimezone(timezone.utc)
    except Exception:
        return datetime.now(timezone.utc)


def _downgrade_confidence(report: InjuryReport, now: datetime) -> InjuryReport:
    age = now - _parse_asof(report)
    if report.source == InjurySource.MANUAL_CONFIRMED:
        if age > timedelta(hours=MANUAL_EXPIRY_HOURS):
            report.confidence = InjuryConfidence.LOW
        else:
            report.confidence = InjuryConfidence.HIGH
    elif report.source == InjurySource.PRIMARY_FPL:
        report.confidence = InjuryConfidence.LOW if age > timedelta(hours=FPL_STALE_HOURS) else InjuryConfidence.HIGH
    elif report.source == InjurySource.SECONDARY_FEED:
        report.confidence = InjuryConfidence.LOW if age > timedelta(hours=SECONDARY_STALE_HOURS) else InjuryConfidence.MED
    else:
        report.confidence = InjuryConfidence.LOW
    return report


def resolve_injury_report(
    candidates: List[InjuryReport],
    now: Optional[datetime] = None,
) -> Tuple[InjuryReport, List[str]]:
    """
    Resolve a single `InjuryReport` given candidates from multiple sources.
    Returns the winning report plus a resolution trace for debugging.
    """
    now = now or datetime.now(timezone.utc)
    trace: List[str] = []

    normalized = [candidate.normalized_status() for candidate in candidates]

    precedence = [
        InjurySource.MANUAL_CONFIRMED,
        InjurySource.PRIMARY_FPL,
        InjurySource.SECONDARY_FEED,
    ]

    for source in precedence:
        source_candidates = [
            _downgrade_confidence(candidate, now)
            for candidate in normalized
            if candidate.source == source
        ]
        if source_candidates:
            winner = max(source_candidates, key=lambda r: _parse_asof(r))
            trace.append(
                f"{source.value} chosen (status={winner.status.value}, confidence={winner.confidence.value})"
            )
            return winner, trace

    unknown = InjuryReport(
        player_id=candidates[0].player_id if candidates else -1,
        status=InjuryStatus.UNKNOWN,
        source=InjurySource.UNKNOWN,
        confidence=InjuryConfidence.LOW,
    )
    trace.append("UNKNOWN fallback - no sources provided")
    return unknown, trace
