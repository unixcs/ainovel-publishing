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


def test_default_slot_advances_when_two_chapters_exceed_daily_limit():
    plan = build_publication_plan(
        [chapter(6, 6000), chapter(7, 8000)],
        start_date=date(2026, 7, 23),
    )
    assert [(item.publication_date, item.publication_time) for item in plan] == [
        ("2026-07-23", "20:00"),
        ("2026-07-24", "20:00"),
    ]


def test_consecutive_chapters_share_a_day_when_combined_quota_fits():
    plan = build_publication_plan(
        [chapter(8, 4544), chapter(9, 4675), chapter(10, 4531), chapter(11, 3923)],
        start_date=date(2026, 7, 25),
    )
    assert [(item.chapter_no, item.publication_date) for item in plan] == [
        (8, "2026-07-25"),
        (9, "2026-07-25"),
        (10, "2026-07-26"),
        (11, "2026-07-26"),
    ]
    assert sum(item.quota_units for item in plan if item.publication_date == "2026-07-25") == 9219
    assert sum(item.quota_units for item in plan if item.publication_date == "2026-07-26") == 8454


def test_existing_schedule_keeps_room_for_next_chapter_on_same_day():
    # 复现用户反馈：第40章已定时到8月12日(4700字)，第41章约4000字，
    # 两章合计8700 < 9999，应都能排到8月12日，而不应把第41章推到8月13日。
    plan = build_publication_plan(
        [chapter(41, 4000)],
        existing_schedules=[{
            "chapter_no": 40,
            "text_sha256": "4" * 64,
            "publication_date": "2026-08-12",
            "publication_time": "20:00",
            "quota_units": 4700,
        }],
        start_date=date(2026, 8, 12),
    )
    assert plan[0].chapter_no == 41
    assert plan[0].publication_date == "2026-08-12"
    assert plan[0].status == "planned"


def test_existing_schedule_is_adopted_and_remaining_daily_quota_is_reused():
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
    assert plan[1].publication_date == "2026-07-23"


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
