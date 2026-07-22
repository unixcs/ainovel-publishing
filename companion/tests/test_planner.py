from datetime import date, datetime

import pytest

from ainovel_companion.planner import PlanningError, build_publication_plan, quota_units_from_text


def chapter(no: int, units: int, status: str = "ready"):
    return {
        "chapter_no": no,
        "title": f"第{no}章",
        "text_sha256": str(no) * 64,
        "quota_units": units,
        "status": status,
    }


def test_count_removes_whitespace():
    assert quota_units_from_text("甲\n乙  丙") == 3


def test_default_slot_and_one_chapter_per_day():
    plan = build_publication_plan(
        [chapter(6, 6000), chapter(7, 8000)],
        start_date=date(2026, 7, 23),
    )
    assert [(item.publication_date, item.publication_time) for item in plan] == [
        ("2026-07-23", "20:00"),
        ("2026-07-24", "20:00"),
    ]


def test_existing_schedule_is_adopted_and_not_duplicated():
    plan = build_publication_plan(
        [chapter(4, 6000), chapter(6, 3000)],
        existing_schedules=[{
            "chapter_no": 4,
            "text_sha256": "4" * 64,
            "publication_date": "2026-07-23",
            "publication_time": "20:00",
            "quota_units": 6000,
        }],
        start_date=date(2026, 7, 23),
    )
    assert plan[0].status == "adopted"
    assert plan[1].publication_date == "2026-07-24"


def test_existing_schedule_version_conflict_blocks():
    plan = build_publication_plan(
        [chapter(4, 6000)],
        existing_schedules=[{
            "chapter_no": 4,
            "text_sha256": "x" * 64,
            "publication_date": "2026-07-23",
            "quota_units": 6000,
        }],
        start_date=date(2026, 7, 23),
    )
    assert plan[0].status == "blocked"
    assert plan[0].reason == "existing_schedule_version_conflict"


def test_existing_schedule_without_version_evidence_is_reserved_without_duplicate_submission():
    plan = build_publication_plan(
        [chapter(4, 6000), chapter(6, 3000)],
        existing_schedules=[{
            "chapter_no": 4,
            "text_sha256": None,
            "publication_date": "2026-07-23",
            "publication_time": "20:00",
            "quota_units": 9999,
            "verified": True,
            "version_verified": False,
        }],
        start_date=date(2026, 7, 23),
    )
    assert plan[0].status == "reserved"
    assert plan[0].reason == "existing_platform_record_unverified"
    assert plan[0].publication_date == "2026-07-23"
    assert plan[1].publication_date == "2026-07-24"


def test_existing_future_schedule_keeps_later_chapter_order_even_when_version_unverified():
    plan = build_publication_plan(
        [chapter(4, 6000), chapter(6, 3000)],
        existing_schedules=[{
            "chapter_no": 4,
            "text_sha256": None,
            "publication_date": "2026-07-24",
            "publication_time": "20:00",
            "quota_units": 9999,
            "verified": True,
            "version_verified": False,
        }],
        start_date=date(2026, 7, 22),
    )
    assert plan[0].publication_date == "2026-07-24"
    assert plan[1].publication_date == "2026-07-25"


def test_over_limit_is_blocked_not_split():
    plan = build_publication_plan([chapter(6, 10000)], start_date=date(2026, 7, 23))
    assert plan[0].status == "blocked"
    assert plan[0].reason == "chapter_exceeds_daily_limit"


def test_previously_filled_editor_is_planned_as_safe_resume_not_new_creation():
    plan = build_publication_plan([chapter(6, 100, status="filled")], start_date=date(2026, 7, 23))
    assert plan[0].status == "planned"
    assert plan[0].reason == "resume_current_editor"
    assert plan[0].publication_date == "2026-07-23"


def test_observed_platform_draft_blocks_new_chapter_creation():
    candidate = chapter(6, 100)
    candidate["platform_state"] = "draft_unverified"
    plan = build_publication_plan([candidate], start_date=date(2026, 7, 23))
    assert plan[0].status == "blocked"
    assert plan[0].reason == "platform_state:draft_unverified"


def test_passed_slot_starts_next_day():
    plan = build_publication_plan(
        [chapter(6, 100)],
        now=datetime(2026, 7, 23, 20, 1),
        start_date=date(2026, 7, 23),
        slot="20:00",
    )
    assert plan[0].publication_date == "2026-07-24"


def test_past_start_date_is_clamped_to_local_today():
    plan = build_publication_plan(
        [chapter(6, 100)],
        now=datetime(2026, 7, 23, 10, 0),
        start_date=date(2026, 7, 1),
        slot="20:00",
    )
    assert plan[0].publication_date == "2026-07-23"


def test_slot_is_configurable():
    plan = build_publication_plan([chapter(6, 100)], start_date=date(2026, 7, 23), slot="12:00")
    assert plan[0].publication_time == "12:00"


def test_invalid_slot_rejected():
    with pytest.raises(PlanningError):
        build_publication_plan([chapter(6, 100)], slot="18:00")
