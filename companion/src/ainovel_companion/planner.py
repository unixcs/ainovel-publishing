from __future__ import annotations

from dataclasses import dataclass, asdict
from datetime import date, datetime, timedelta
from typing import Any, Iterable, Mapping
from zoneinfo import ZoneInfo

DEFAULT_TIMEZONE = "Asia/Shanghai"
DEFAULT_DAILY_LIMIT = 9999
DEFAULT_SLOTS = ("12:00", "20:00", "22:00")
DEFAULT_SLOT = "20:00"


class PlanningError(ValueError):
    """Raised when a publication plan cannot be made safely."""


@dataclass(frozen=True)
class ChapterCandidate:
    chapter_no: int
    title: str
    text_sha256: str
    quota_units: int
    status: str = "ready"
    platform_state: str | None = None


@dataclass(frozen=True)
class ExistingSchedule:
    chapter_no: int
    text_sha256: str | None
    publication_date: str
    publication_time: str | None = None
    quota_units: int = 0
    verified: bool = True
    version_verified: bool = True


@dataclass(frozen=True)
class PlanItem:
    chapter_no: int
    title: str
    text_sha256: str
    quota_units: int
    publication_date: str | None
    publication_time: str | None
    status: str
    reason: str | None = None

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


def normalize_slot(slot: str, slots: Iterable[str] = DEFAULT_SLOTS) -> str:
    value = str(slot or "").strip()
    allowed = tuple(str(item) for item in slots)
    if value not in allowed:
        raise PlanningError(f"unsupported_publication_slot:{value}")
    return value


def quota_units_from_text(text: str) -> int:
    """Count visible non-whitespace text units conservatively like the page adapter."""
    return len("".join(str(text or "").split()))


def local_today(timezone_name: str = DEFAULT_TIMEZONE, now: datetime | None = None) -> date:
    zone = ZoneInfo(timezone_name)
    current = now.astimezone(zone) if now and now.tzinfo else (now or datetime.now(zone))
    return current.date()


def _next_date_with_slot(
    start: date,
    slot: str,
    timezone_name: str,
    now: datetime | None,
) -> date:
    """Do not plan a slot that has already passed in the selected local timezone."""
    if not now:
        return start
    zone = ZoneInfo(timezone_name)
    current = now.astimezone(zone) if now.tzinfo else now.replace(tzinfo=zone)
    hour, minute = (int(part) for part in slot.split(":", 1))
    if start == current.date() and (current.hour, current.minute) >= (hour, minute):
        return start + timedelta(days=1)
    return start


def build_publication_plan(
    candidates: Iterable[Mapping[str, Any] | ChapterCandidate],
    existing_schedules: Iterable[Mapping[str, Any] | ExistingSchedule] = (),
    *,
    start_date: date | None = None,
    now: datetime | None = None,
    timezone_name: str = DEFAULT_TIMEZONE,
    daily_limit: int = DEFAULT_DAILY_LIMIT,
    slot: str = DEFAULT_SLOT,
    slots: Iterable[str] = DEFAULT_SLOTS,
) -> list[PlanItem]:
    """Plan one safe chapter per selected publication slot/day.

    Existing verified schedules reserve quota and are adopted rather than duplicated.
    The first implementation deliberately uses one chapter per publication date; this
    avoids scheduling two chapters for the same platform timestamp while leaving room
    for a future explicit multi-slot policy.
    """
    if daily_limit <= 0:
        raise PlanningError("daily_limit_must_be_positive")
    slot = normalize_slot(slot, slots)
    today = local_today(timezone_name, now)
    if start_date is None or start_date < today:
        start_date = today
    start_date = _next_date_with_slot(start_date, slot, timezone_name, now)

    usage: dict[str, int] = {}
    adopted: dict[int, ExistingSchedule] = {}
    for raw in existing_schedules:
        item = raw if isinstance(raw, ExistingSchedule) else ExistingSchedule(
            chapter_no=int(raw["chapter_no"]),
            text_sha256=raw.get("text_sha256"),
            publication_date=str(raw["publication_date"]),
            publication_time=raw.get("publication_time"),
            quota_units=int(raw.get("quota_units") or 0),
            verified=bool(raw.get("verified", True)),
            version_verified=bool(raw.get("version_verified", True)),
        )
        if not item.verified:
            continue
        usage[item.publication_date] = usage.get(item.publication_date, 0) + max(item.quota_units, 0)
        adopted[item.chapter_no] = item

    normalized: list[ChapterCandidate] = []
    for raw in candidates:
        item = raw if isinstance(raw, ChapterCandidate) else ChapterCandidate(
            chapter_no=int(raw["chapter_no"]),
            title=str(raw.get("title") or ""),
            text_sha256=str(raw["text_sha256"]),
            quota_units=int(raw.get("quota_units", raw.get("char_count", 0))),
            status=str(raw.get("status") or "ready"),
            platform_state=str(raw["platform_state"]) if raw.get("platform_state") else None,
        )
        normalized.append(item)
    normalized.sort(key=lambda item: item.chapter_no)

    result: list[PlanItem] = []
    cursor = start_date
    for candidate in normalized:
        if candidate.chapter_no in adopted:
            existing = adopted[candidate.chapter_no]
            if not existing.version_verified or not existing.text_sha256:
                result.append(PlanItem(
                    candidate.chapter_no, candidate.title, candidate.text_sha256,
                    candidate.quota_units, existing.publication_date,
                    existing.publication_time or slot, "blocked",
                    "existing_schedule_version_unverified",
                ))
            elif existing.text_sha256 != candidate.text_sha256:
                result.append(PlanItem(
                    candidate.chapter_no, candidate.title, candidate.text_sha256,
                    candidate.quota_units, existing.publication_date,
                    existing.publication_time or slot, "blocked",
                    "existing_schedule_version_conflict",
                ))
            else:
                result.append(PlanItem(
                    candidate.chapter_no, candidate.title, candidate.text_sha256,
                    candidate.quota_units, existing.publication_date,
                    existing.publication_time or slot, "adopted",
                    "existing_verified_schedule",
                ))
            try:
                existing_date = date.fromisoformat(existing.publication_date)
                cursor = max(cursor, existing_date + timedelta(days=1))
            except ValueError:
                pass
            continue

        if candidate.platform_state:
            result.append(PlanItem(
                candidate.chapter_no, candidate.title, candidate.text_sha256,
                candidate.quota_units, None, None, "blocked",
                f"platform_state:{candidate.platform_state}",
            ))
            continue

        if candidate.status in {
            "version_conflict", "blocked", "legacy_published", "legacy_draft",
            "fill_started", "filled", "awaiting_ai_choice", "submitted",
            "published", "scheduled", "saved_draft",
        }:
            result.append(PlanItem(
                candidate.chapter_no, candidate.title, candidate.text_sha256,
                candidate.quota_units, None, None, "blocked",
                f"chapter_status:{candidate.status}",
            ))
            continue
        if candidate.quota_units <= 0:
            result.append(PlanItem(
                candidate.chapter_no, candidate.title, candidate.text_sha256,
                candidate.quota_units, None, None, "blocked", "empty_chapter",
            ))
            continue
        if candidate.quota_units > daily_limit:
            result.append(PlanItem(
                candidate.chapter_no, candidate.title, candidate.text_sha256,
                candidate.quota_units, None, None, "blocked", "chapter_exceeds_daily_limit",
            ))
            continue

        # One chapter per publication slot/day. Existing quota is still checked so a
        # future platform observation can block a date rather than overbook it.
        while usage.get(cursor.isoformat(), 0) + candidate.quota_units > daily_limit:
            cursor += timedelta(days=1)
        publication_date = cursor.isoformat()
        usage[publication_date] = usage.get(publication_date, 0) + candidate.quota_units
        result.append(PlanItem(
            candidate.chapter_no, candidate.title, candidate.text_sha256,
            candidate.quota_units, publication_date, slot, "planned",
        ))
        cursor += timedelta(days=1)

    return result
