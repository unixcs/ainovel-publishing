from pathlib import Path

import pytest

from ainovel_companion.db import PublishingDB


def entry(chapter_no: int, text_hash: str) -> dict:
    return {
        "chapter_no": chapter_no,
        "title": f"第{chapter_no}章",
        "source_file": f"{chapter_no:02d}.md",
        "source_sha256": "a" * 64,
        "text_sha256": text_hash,
        "char_count": 10,
        "line_count": 2,
        "generated_at": "2026-07-22T00:00:00Z",
        "text_path": f"chapters/{chapter_no:04d}.txt",
        "zip_path": f"ready/{chapter_no:04d}.zip",
        "duplicate_of": None,
    }


def test_bootstrap_states(tmp_path: Path):
    db = PublishingDB(tmp_path / "publisher.db")
    assert db.upsert_manifest_entry("示例小说", entry(1, "1" * 64), "one")["status"] == "legacy_published"
    assert db.upsert_manifest_entry("示例小说", entry(4, "4" * 64), "four")["status"] == "legacy_draft"
    assert db.upsert_manifest_entry("示例小说", entry(5, "5" * 64), "five")["status"] == "ready"


def test_platform_title_only_suffixes_later_duplicate_occurrences(tmp_path: Path):
    db = PublishingDB(tmp_path / "publisher.db")
    first = entry(24, "2" * 64)
    first["title"] = "第二十四章 晨钟"
    second = entry(35, "3" * 64)
    second["title"] = "第三十五章 晨钟"
    third = entry(50, "5" * 64)
    third["title"] = "第五十章 晨钟"
    db.upsert_manifest_entry("示例小说", first, "first")
    db.upsert_manifest_entry("示例小说", second, "second")
    db.upsert_manifest_entry("示例小说", third, "third")

    assert db.get_chapter("示例小说", 24)["platform_title"] == "晨钟"
    assert db.get_chapter("示例小说", 35)["platform_title"] == "晨钟（二）"
    assert db.get_chapter("示例小说", 50)["platform_title"] == "晨钟（三）"


def test_explicit_platform_rejection_is_not_left_as_submitted_unverified(tmp_path: Path):
    db = PublishingDB(tmp_path / "publisher.db")
    row = db.upsert_manifest_entry("示例小说", entry(35, "3" * 64), "body")
    db.record_event(row["book_id"], 35, "final_submit_armed", "3" * 64, {
        "plan_id": "missing-plan-is-allowed-for-event",
        "platform_state": "submitted_unverified",
    })
    rejected = db.record_event(row["book_id"], 35, "submission_rejected", "3" * 64, {
        "error": "platform_submission_rejected",
        "platform_state": "draft_rejected",
        "rejection_message": "本书中存在重复标题，请修改后再发布",
    })
    assert rejected["status"] == "blocked"
    assert rejected["platform_state"] == "draft_rejected"
    assert rejected["last_error"] == "platform_submission_rejected"


def test_changed_published_version_becomes_conflict(tmp_path: Path):
    db = PublishingDB(tmp_path / "publisher.db")
    row = db.upsert_manifest_entry("示例小说", entry(5, "5" * 64), "old")
    book_id = row["book_id"]
    db.record_event(book_id, 5, "published", "5" * 64, {"platform_state": "published"})
    changed = db.upsert_manifest_entry("示例小说", entry(5, "6" * 64), "new")
    assert changed["status"] == "version_conflict"
    assert changed["version"] == 2


def test_changed_filled_version_becomes_conflict_instead_of_new_ready_chapter(tmp_path: Path):
    db = PublishingDB(tmp_path / "publisher.db")
    row = db.upsert_manifest_entry("示例小说", entry(6, "6" * 64), "old")
    db.record_event(row["book_id"], 6, "filled", "6" * 64, {})
    changed = db.upsert_manifest_entry("示例小说", entry(6, "7" * 64), "new")
    assert changed["status"] == "version_conflict"
    assert changed["version"] == 2


def test_stale_event_is_rejected(tmp_path: Path):
    db = PublishingDB(tmp_path / "publisher.db")
    row = db.upsert_manifest_entry("示例小说", entry(5, "5" * 64), "body")
    with pytest.raises(ValueError, match="stale_chapter_version"):
        db.record_event(row["book_id"], 5, "filled", "6" * 64, {})


def test_failed_attempt_keeps_ready_status(tmp_path: Path):
    db = PublishingDB(tmp_path / "publisher.db")
    row = db.upsert_manifest_entry("示例小说", entry(5, "5" * 64), "body")
    started = db.record_event(row["book_id"], 5, "fill_started", "5" * 64, {})
    assert started["status"] == "ready"
    failed = db.record_event(row["book_id"], 5, "failed", "5" * 64, {"error": "selector missing"})
    assert failed["status"] == "ready"
    assert failed["last_error"] == "selector missing"


def test_blocked_attempt_records_error_and_can_be_explicitly_resumed(tmp_path: Path):
    db = PublishingDB(tmp_path / "publisher.db")
    row = db.upsert_manifest_entry("示例小说", entry(6, "6" * 64), "body")
    db.create_publication_plan(
        row["book_id"],
        timezone="Asia/Shanghai",
        daily_limit=9999,
        default_slot="20:00",
        ai_policy="remember",
        plan_id="plan-resume",
        items=[{
            "chapter_no": 6,
            "text_sha256": "6" * 64,
            "title": "第6章",
            "quota_units": 4,
            "publication_date": "2026-07-23",
            "publication_time": "20:00",
            "status": "planned",
        }],
    )
    db.approve_publication_plan("plan-resume")
    blocked = db.record_event(row["book_id"], 6, "blocked", "6" * 64, {
        "plan_id": "plan-resume",
        "error": "login_required",
    })
    assert blocked["status"] == "blocked"
    assert blocked["last_error"] == "login_required"
    assert db.get_publication_plan("plan-resume")["items"][0]["reason"] == "login_required"

    resumed = db.resume_plan_item(
        "plan-resume",
        6,
        "6" * 64,
        acknowledgement="platform_checked_no_submission",
    )
    assert resumed["items"][0]["status"] == "planned"
    assert resumed["items"][0]["reason"] is None
    chapter = db.get_chapter(row["book_id"], 6)
    assert chapter["status"] == "planned"
    assert chapter["last_error"] is None
    assert db.list_events(row["book_id"], 6)[-1]["event_type"] == "resumed"


def test_resume_rejects_missing_acknowledgement_or_platform_state(tmp_path: Path):
    db = PublishingDB(tmp_path / "publisher.db")
    row = db.upsert_manifest_entry("示例小说", entry(6, "6" * 64), "body")
    db.create_publication_plan(
        row["book_id"],
        timezone="Asia/Shanghai",
        daily_limit=9999,
        default_slot="20:00",
        ai_policy="remember",
        plan_id="plan-resume",
        items=[{
            "chapter_no": 6,
            "text_sha256": "6" * 64,
            "title": "第6章",
            "quota_units": 4,
            "publication_date": "2026-07-23",
            "publication_time": "20:00",
            "status": "planned",
        }],
    )
    db.approve_publication_plan("plan-resume")
    db.record_event(row["book_id"], 6, "blocked", "6" * 64, {
        "plan_id": "plan-resume",
        "error": "submission_unverified",
        "platform_state": "scheduled_unverified",
    })
    with pytest.raises(ValueError, match="resume_acknowledgement_required"):
        db.resume_plan_item("plan-resume", 6, "6" * 64, acknowledgement="")
    with pytest.raises(ValueError, match="platform_state_requires_reconciliation"):
        db.resume_plan_item(
            "plan-resume", 6, "6" * 64,
            acknowledgement="platform_checked_no_submission",
        )


def test_post_mutation_block_cannot_be_reset_to_new_chapter_flow(tmp_path: Path):
    db = PublishingDB(tmp_path / "publisher.db")
    row = db.upsert_manifest_entry("示例小说", entry(6, "6" * 64), "body")
    db.create_publication_plan(
        row["book_id"], timezone="Asia/Shanghai", daily_limit=9999,
        default_slot="20:00", ai_policy="remember", plan_id="plan-post-mutation",
        items=[{
            "chapter_no": 6, "text_sha256": "6" * 64, "title": "第6章",
            "quota_units": 4, "publication_date": "2026-07-23",
            "publication_time": "20:00", "status": "planned",
        }],
    )
    db.approve_publication_plan("plan-post-mutation")
    db.record_event(row["book_id"], 6, "blocked", "6" * 64, {
        "plan_id": "plan-post-mutation",
        "error": "full_check_timeout",
    })
    with pytest.raises(ValueError, match="blocked_stage_requires_reconciliation"):
        db.resume_plan_item(
            "plan-post-mutation", 6, "6" * 64,
            acknowledgement="platform_checked_no_submission",
        )


def test_publication_plan_and_schedule_event_are_durable(tmp_path: Path):
    db = PublishingDB(tmp_path / "publisher.db")
    row = db.upsert_manifest_entry("示例小说", entry(6, "6" * 64), "body")
    plan = db.create_publication_plan(
        row["book_id"],
        timezone="Asia/Shanghai",
        daily_limit=9999,
        default_slot="20:00",
        ai_policy="remember",
        plan_id="plan-1",
        items=[{
            "chapter_no": 6,
            "text_sha256": "6" * 64,
            "title": "第6章",
            "quota_units": 4,
            "publication_date": "2026-07-23",
            "publication_time": "20:00",
            "status": "planned",
        }],
    )
    assert plan["status"] == "draft"
    approved = db.approve_publication_plan("plan-1")
    assert approved["status"] == "approved"
    db.record_event(row["book_id"], 6, "schedule_verified", "6" * 64, {
        "plan_id": "plan-1",
        "platform_state": "scheduled",
        "publication_date": "2026-07-23",
        "publication_time": "20:00",
        "quota_units": 4,
    })
    saved = db.get_publication_plan("plan-1")
    assert saved["items"][0]["status"] == "scheduled"
    assert db.get_chapter(row["book_id"], 6)["status"] == "scheduled"
    assert db.list_verified_schedules(row["book_id"])[0]["publication_date"] == "2026-07-23"


def test_manual_ai_pause_is_durable_in_chapter_and_plan(tmp_path: Path):
    db = PublishingDB(tmp_path / "publisher.db")
    row = db.upsert_manifest_entry("示例小说", entry(6, "6" * 64), "body")
    db.create_publication_plan(
        row["book_id"], timezone="Asia/Shanghai", daily_limit=9999,
        default_slot="20:00", ai_policy="ask", plan_id="plan-ai",
        items=[{
            "chapter_no": 6, "text_sha256": "6" * 64, "title": "第6章",
            "quota_units": 4, "publication_date": "2026-07-23",
            "publication_time": "20:00", "status": "planned",
        }],
    )
    db.approve_publication_plan("plan-ai")
    chapter = db.record_event(row["book_id"], 6, "awaiting_ai_choice", "6" * 64, {
        "plan_id": "plan-ai",
        "publication_date": "2026-07-23",
        "publication_time": "20:00",
    })
    assert chapter["status"] == "awaiting_ai_choice"
    assert db.get_publication_plan("plan-ai")["items"][0]["status"] == "awaiting_ai_choice"


def test_observed_schedule_requires_separate_chapter_version_verification(tmp_path: Path):
    db = PublishingDB(tmp_path / "publisher.db")
    row = db.upsert_manifest_entry("示例小说", entry(6, "6" * 64), "body")
    observed = db.record_event(row["book_id"], 6, "schedule_observed", "6" * 64, {
        "platform_state": "scheduled_unverified",
        "publication_date": "2026-07-23",
        "publication_time": "20:00",
        "quota_units": 9999,
        "version_verified": False,
    })
    assert observed["status"] == "ready"
    schedule = db.list_verified_schedules(row["book_id"])[0]
    assert schedule["text_sha256"] is None
    assert schedule["version_verified"] is False

    verified = db.record_event(row["book_id"], 6, "schedule_verified", "6" * 64, {
        "platform_state": "scheduled",
        "publication_date": "2026-07-23",
        "publication_time": "20:00",
        "quota_units": 4,
        "version_verified": True,
    })
    assert verified["status"] == "scheduled"
    schedule = db.list_verified_schedules(row["book_id"])[0]
    assert schedule["text_sha256"] == "6" * 64
    assert schedule["version_verified"] is True


def test_rescheduled_schedule_replaces_the_previous_verified_date(tmp_path: Path):
    db = PublishingDB(tmp_path / "publisher.db")
    row = db.upsert_manifest_entry("示例小说", entry(9, "9" * 64), "正文")
    db.record_event(row["book_id"], 9, "schedule_verified", "9" * 64, {
        "platform_state": "scheduled",
        "publication_date": "2026-07-26",
        "publication_time": "20:00",
        "quota_units": 2,
        "version_verified": True,
    })
    changed = db.record_event(row["book_id"], 9, "schedule_rescheduled", "9" * 64, {
        "platform_state": "scheduled",
        "publication_date": "2026-07-25",
        "publication_time": "20:00",
        "quota_units": 2,
        "version_verified": True,
    })
    assert changed["status"] == "scheduled"
    assert changed["last_error"] is None
    schedule = db.list_verified_schedules(row["book_id"])[0]
    assert schedule["publication_date"] == "2026-07-25"
    assert schedule["publication_time"] == "20:00"
    assert schedule["text_sha256"] == "9" * 64
    assert schedule["version_verified"] is True


def _approved_single_item_plan(db: PublishingDB, row: dict, plan_id: str = "recovery-plan") -> None:
    db.create_publication_plan(
        row["book_id"], timezone="Asia/Shanghai", daily_limit=9999,
        default_slot="20:00", ai_policy="remember", plan_id=plan_id,
        items=[{
            "chapter_no": row["chapter_no"], "text_sha256": row["text_sha256"],
            "title": row["title"], "quota_units": 4,
            "publication_date": "2026-07-25", "publication_time": "20:00",
            "status": "planned",
        }],
    )
    db.approve_publication_plan(plan_id)


def test_next_clicked_without_final_submit_can_recover_after_platform_absence(tmp_path: Path):
    db = PublishingDB(tmp_path / "publisher.db")
    row = db.upsert_manifest_entry("示例小说", entry(8, "8" * 64), "body")
    _approved_single_item_plan(db, row)
    payload = {"plan_id": "recovery-plan"}
    db.record_event(row["book_id"], 8, "automation_started", "8" * 64, payload)
    db.record_event(row["book_id"], 8, "filled", "8" * 64, payload)
    db.record_event(row["book_id"], 8, "next_clicked", "8" * 64, payload)
    db.record_event(row["book_id"], 8, "blocked", "8" * 64, {**payload, "error": "automation_blocked"})

    recovery = db.get_chapter_recovery(row["book_id"], 8)
    assert recovery == {
        "allowed": True,
        "mode": "recover_unsubmitted",
        "reason": "platform_absence_check_required",
        "last_checkpoint": "next_clicked",
        "plan_id": "recovery-plan",
    }
    recovered = db.recover_unsubmitted_chapter(
        row["book_id"], 8, "8" * 64,
        acknowledgement="platform_checked_chapter_absent",
        platform_found=False,
        evidence_url="https://fanqienovel.com/main/writer/chapter-manage/1234567890123",
    )
    assert recovered["chapter"]["status"] == "ready"
    assert recovered["recovery"]["allowed"] is False
    assert recovered["superseded_plan_ids"] == ["recovery-plan"]
    assert db.get_publication_plan("recovery-plan")["status"] == "superseded"
    assert [event["event_type"] for event in db.list_events(row["book_id"], 8)][-2:] == [
        "platform_absence_observed", "recovered_unsubmitted",
    ]


def test_final_submit_armed_cannot_return_to_new_chapter_flow(tmp_path: Path):
    db = PublishingDB(tmp_path / "publisher.db")
    row = db.upsert_manifest_entry("示例小说", entry(8, "8" * 64), "body")
    _approved_single_item_plan(db, row)
    payload = {"plan_id": "recovery-plan"}
    for event_type in ("automation_started", "filled", "next_clicked", "final_submit_armed"):
        db.record_event(row["book_id"], 8, event_type, "8" * 64, payload)
    assert db.get_chapter(row["book_id"], 8)["status"] == "submitted"
    assert db.get_publication_plan("recovery-plan")["items"][0]["status"] == "submitted"
    db.record_event(row["book_id"], 8, "blocked", "8" * 64, {**payload, "error": "submission_unverified"})

    recovery = db.get_chapter_recovery(row["book_id"], 8)
    assert recovery["allowed"] is False
    assert recovery["reason"] == "final_submission_requires_reconciliation"
    assert recovery["last_checkpoint"] == "final_submit_armed"
    with pytest.raises(ValueError, match="final_submission_requires_reconciliation"):
        db.recover_unsubmitted_chapter(
            row["book_id"], 8, "8" * 64,
            acknowledgement="platform_checked_chapter_absent",
            platform_found=False,
        )


def test_schedule_submitted_cannot_be_recovered_as_unsubmitted(tmp_path: Path):
    db = PublishingDB(tmp_path / "publisher.db")
    row = db.upsert_manifest_entry("示例小说", entry(8, "8" * 64), "body")
    _approved_single_item_plan(db, row)
    payload = {"plan_id": "recovery-plan"}
    db.record_event(row["book_id"], 8, "automation_started", "8" * 64, payload)
    db.record_event(row["book_id"], 8, "schedule_submitted", "8" * 64, payload)
    db.record_event(row["book_id"], 8, "blocked", "8" * 64, {**payload, "error": "readback_unknown"})
    assert db.get_chapter_recovery(row["book_id"], 8)["reason"] == "final_submission_requires_reconciliation"


def test_only_newest_draft_and_one_approved_plan_stay_active(tmp_path: Path):
    db = PublishingDB(tmp_path / "publisher.db")
    row = db.upsert_manifest_entry("示例小说", entry(8, "8" * 64), "body")
    item = [{
        "chapter_no": 8, "text_sha256": "8" * 64, "title": "第8章",
        "quota_units": 4, "publication_date": "2026-07-25",
        "publication_time": "20:00", "status": "planned",
    }]
    for plan_id in ("first", "second"):
        db.create_publication_plan(
            row["book_id"], timezone="Asia/Shanghai", daily_limit=9999,
            default_slot="20:00", ai_policy="remember", plan_id=plan_id, items=item,
        )
    assert db.get_publication_plan("first")["status"] == "superseded"
    db.approve_publication_plan("second")
    db.create_publication_plan(
        row["book_id"], timezone="Asia/Shanghai", daily_limit=9999,
        default_slot="20:00", ai_policy="remember", plan_id="third", items=item,
    )
    db.approve_publication_plan("third")
    assert db.get_publication_plan("second")["status"] == "superseded"
    assert db.get_publication_plan("third")["status"] == "approved"
