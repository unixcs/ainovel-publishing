from pathlib import Path

from fastapi.testclient import TestClient

from ainovel_companion import __version__
from ainovel_companion.api import create_app
from ainovel_companion.config import APIConfig, AppConfig, RemoteConfig, SSHConfig
from ainovel_companion.db import PublishingDB


AUTH_HEADERS = {
    "X-Ainovel-Token": "secret",
    "X-Ainovel-Client-Version": __version__,
}


def config(tmp_path: Path) -> AppConfig:
    return AppConfig(
        config_path=tmp_path / "config.json",
        data_dir=tmp_path,
        database_path=tmp_path / "publisher.db",
        ssh=SSHConfig("example", 22, "admin", None, None, 10),
        remote=RemoteConfig("true", "/manifest", "/release/示例小说"),
        api=APIConfig("127.0.0.1", 8787, "secret"),
    )


def test_api_requires_token(tmp_path: Path):
    cfg = config(tmp_path)
    db = PublishingDB(cfg.database_path)
    client = TestClient(create_app(cfg, db))
    assert client.get("/api/v1/health").status_code == 200
    assert client.get("/api/v1/books").status_code == 401
    token_only = {"X-Ainovel-Token": "secret"}
    assert client.get("/api/v1/books", headers=token_only).status_code == 409
    stale = {**AUTH_HEADERS, "X-Ainovel-Client-Version": "0.3.2"}
    stale_response = client.get("/api/v1/books", headers=stale)
    assert stale_response.status_code == 409
    assert stale_response.json()["detail"] == f"stale_extension_version:expected={__version__}"
    assert client.get("/api/v1/books", headers=AUTH_HEADERS).status_code == 200


def test_publication_plan_api_and_platform_observation(tmp_path: Path):
    cfg = config(tmp_path)
    db = PublishingDB(cfg.database_path)
    row = db.upsert_manifest_entry("示例小说", {
        "chapter_no": 6,
        "title": "第6章",
        "source_file": "06.md",
        "source_sha256": "a" * 64,
        "text_sha256": "6" * 64,
        "char_count": 6,
        "line_count": 1,
        "generated_at": "2026-07-22T00:00:00Z",
        "text_path": "chapters/0006.txt",
        "zip_path": "ready/0006.zip",
        "duplicate_of": None,
    }, "一二三四五六")
    client = TestClient(create_app(cfg, db))
    headers = AUTH_HEADERS
    response = client.post(
        f"/api/v1/books/{row['book_id']}/publication-plans",
        headers=headers,
        json={"slot": "20:00", "daily_limit": 9999, "ai_policy": "remember", "start_date": "2026-07-24"},
    )
    assert response.status_code == 200
    plan = response.json()
    assert plan["items"][0]["publication_date"] == "2026-07-24"
    approved = client.post(f"/api/v1/publication-plans/{plan['plan_id']}/approve", headers=headers)
    assert approved.status_code == 200
    observed = client.post(
        f"/api/v1/books/{row['book_id']}/platform-observations",
        headers=headers,
        json={"observations": [{
            "chapter_no": 6,
            "text_sha256": "6" * 64,
            "publication_date": "2026-07-24",
            "publication_time": "20:00",
            "quota_units": 6,
            "version_verified": True,
        }]},
    )
    assert observed.status_code == 200
    assert db.get_chapter(row["book_id"], 6)["status"] == "scheduled"


def test_platform_schedule_observation_does_not_claim_body_version(tmp_path: Path):
    cfg = config(tmp_path)
    db = PublishingDB(cfg.database_path)
    row = db.upsert_manifest_entry("示例小说", {
        "chapter_no": 6,
        "title": "第6章",
        "source_file": "06.md",
        "source_sha256": "a" * 64,
        "text_sha256": "6" * 64,
        "char_count": 6,
        "line_count": 1,
        "generated_at": "2026-07-22T00:00:00Z",
        "text_path": "chapters/0006.txt",
        "zip_path": "ready/0006.zip",
        "duplicate_of": None,
    }, "一二三四五六")
    client = TestClient(create_app(cfg, db))
    response = client.post(
        f"/api/v1/books/{row['book_id']}/platform-observations",
        headers=AUTH_HEADERS,
        json={"observations": [{
            "chapter_no": 6,
            "text_sha256": "6" * 64,
            "publication_date": "2026-07-23",
            "publication_time": "20:00",
            "quota_units": 9999,
            "platform_state": "scheduled",
            "version_verified": False,
            "evidence": "第 6 章 定时发布 2026-07-23 20:00",
        }]},
    )
    assert response.status_code == 200
    chapter = db.get_chapter(row["book_id"], 6)
    assert chapter["status"] == "ready"
    assert chapter["platform_state"] == "scheduled_unverified"
    schedule = db.list_verified_schedules(row["book_id"])[0]
    assert schedule["text_sha256"] is None
    assert schedule["version_verified"] is False

    # Existence/date evidence is enough to skip duplicate creation and reserve the
    # full daily quota. Body verification remains a visible recommendation, not a
    # global stop that prevents later chapters from being planned.
    plan_response = client.post(
        f"/api/v1/books/{row['book_id']}/publication-plans",
        headers=AUTH_HEADERS,
        json={"slot": "20:00", "daily_limit": 9999, "ai_policy": "remember", "start_date": "2026-07-23"},
    )
    assert plan_response.status_code == 200
    plan = plan_response.json()
    assert plan["items"][0]["status"] == "reserved"
    approved = client.post(
        f"/api/v1/publication-plans/{plan['plan_id']}/approve",
        headers=AUTH_HEADERS,
    )
    assert approved.status_code == 200


def test_verified_schedule_requires_read_back_time(tmp_path: Path):
    cfg = config(tmp_path)
    db = PublishingDB(cfg.database_path)
    row = db.upsert_manifest_entry("示例小说", {
        "chapter_no": 6, "title": "第6章", "source_file": "06.md",
        "source_sha256": "a" * 64, "text_sha256": "6" * 64,
        "char_count": 6, "line_count": 1,
        "generated_at": "2026-07-22T00:00:00Z", "text_path": "chapters/0006.txt",
        "zip_path": None, "duplicate_of": None,
    }, "一二三四五六")
    client = TestClient(create_app(cfg, db))
    response = client.post(
        f"/api/v1/books/{row['book_id']}/platform-observations",
        headers=AUTH_HEADERS,
        json={"observations": [{
            "chapter_no": 6, "text_sha256": "6" * 64,
            "publication_date": "2026-07-23", "publication_time": None,
            "quota_units": 6, "platform_state": "scheduled", "version_verified": True,
        }]},
    )
    assert response.status_code == 422
    assert response.json()["detail"] == "verified_schedule_requires_publication_time"


def test_plan_cannot_exceed_configured_daily_safety_cap(tmp_path: Path):
    cfg = config(tmp_path)
    db = PublishingDB(cfg.database_path)
    row = db.upsert_manifest_entry("示例小说", {
        "chapter_no": 6, "title": "第6章", "source_file": "06.md",
        "source_sha256": "a" * 64, "text_sha256": "6" * 64,
        "char_count": 6, "line_count": 1,
        "generated_at": "2026-07-22T00:00:00Z", "text_path": "chapters/0006.txt",
        "zip_path": "ready/0006.zip", "duplicate_of": None,
    }, "一二三四五六")
    client = TestClient(create_app(cfg, db))
    response = client.post(
        f"/api/v1/books/{row['book_id']}/publication-plans",
        headers=AUTH_HEADERS,
        json={"slot": "20:00", "daily_limit": 10000, "ai_policy": "remember"},
    )
    assert response.status_code == 422
    assert response.json()["detail"] == "daily_limit_exceeds_configured_safety_cap"


def test_unreconciled_earlier_draft_blocks_plan_approval(tmp_path: Path):
    cfg = config(tmp_path)
    db = PublishingDB(cfg.database_path)
    common = {
        "source_sha256": "a" * 64, "char_count": 6, "line_count": 1,
        "generated_at": "2026-07-22T00:00:00Z", "duplicate_of": None,
    }
    fourth = db.upsert_manifest_entry("示例小说", {
        **common, "chapter_no": 4, "title": "第4章", "source_file": "04.md",
        "text_sha256": "4" * 64, "text_path": "chapters/0004.txt", "zip_path": None,
    }, "第四章正文")
    db.upsert_manifest_entry("示例小说", {
        **common, "chapter_no": 5, "title": "第5章", "source_file": "05.md",
        "text_sha256": "5" * 64, "text_path": "chapters/0005.txt", "zip_path": None,
    }, "第五章正文")
    client = TestClient(create_app(cfg, db))
    headers = AUTH_HEADERS
    response = client.post(
        f"/api/v1/books/{fourth['book_id']}/publication-plans",
        headers=headers,
        json={"slot": "20:00", "daily_limit": 9999, "ai_policy": "remember", "start_date": "2026-07-23"},
    )
    assert response.status_code == 200
    plan = response.json()
    assert plan["items"][0]["chapter_no"] == 4
    assert plan["items"][0]["status"] == "blocked"
    assert plan["items"][0]["reason"] == "chapter_status:legacy_draft"
    approval = client.post(f"/api/v1/publication-plans/{plan['plan_id']}/approve", headers=headers)
    assert approval.status_code == 409
    assert approval.json()["detail"] == "plan_contains_blocked_items"


def test_blocked_plan_item_resume_api(tmp_path: Path):
    cfg = config(tmp_path)
    db = PublishingDB(cfg.database_path)
    row = db.upsert_manifest_entry("示例小说", {
        "chapter_no": 6,
        "title": "第6章",
        "source_file": "06.md",
        "source_sha256": "a" * 64,
        "text_sha256": "6" * 64,
        "char_count": 6,
        "line_count": 1,
        "generated_at": "2026-07-22T00:00:00Z",
        "text_path": "chapters/0006.txt",
        "zip_path": "ready/0006.zip",
        "duplicate_of": None,
    }, "一二三四五六")
    db.create_publication_plan(
        row["book_id"], timezone="Asia/Shanghai", daily_limit=9999,
        default_slot="20:00", ai_policy="remember", plan_id="resume-api",
        items=[{
            "chapter_no": 6, "text_sha256": "6" * 64, "title": "第6章",
            "quota_units": 6, "publication_date": "2026-07-23",
            "publication_time": "20:00", "status": "planned",
        }],
    )
    db.approve_publication_plan("resume-api")
    db.record_event(row["book_id"], 6, "blocked", "6" * 64, {
        "plan_id": "resume-api", "error": "login_required",
    })
    client = TestClient(create_app(cfg, db))
    response = client.post(
        "/api/v1/publication-plans/resume-api/items/6/resume",
        headers=AUTH_HEADERS,
        json={
            "text_sha256": "6" * 64,
            "acknowledgement": "platform_checked_no_submission",
        },
    )
    assert response.status_code == 200
    assert response.json()["items"][0]["status"] == "planned"


def test_recover_unsubmitted_chapter_api_uses_checkpoint_and_absence_evidence(tmp_path: Path):
    cfg = config(tmp_path)
    db = PublishingDB(cfg.database_path)
    row = db.upsert_manifest_entry("示例小说", {
        "chapter_no": 8, "title": "第8章", "source_file": "08.md",
        "source_sha256": "a" * 64, "text_sha256": "8" * 64,
        "char_count": 4, "line_count": 1, "generated_at": "2026-07-22T00:00:00Z",
        "text_path": "chapters/0008.txt", "zip_path": "ready/0008.zip", "duplicate_of": None,
    }, "正文内容")
    db.create_publication_plan(
        row["book_id"], timezone="Asia/Shanghai", daily_limit=9999,
        default_slot="20:00", ai_policy="remember", plan_id="api-recovery",
        items=[{
            "chapter_no": 8, "text_sha256": "8" * 64, "title": "第8章",
            "quota_units": 4, "publication_date": "2026-07-25",
            "publication_time": "20:00", "status": "planned",
        }],
    )
    db.approve_publication_plan("api-recovery")
    for event_type in ("automation_started", "filled", "next_clicked"):
        db.record_event(row["book_id"], 8, event_type, "8" * 64, {"plan_id": "api-recovery"})
    db.record_event(row["book_id"], 8, "blocked", "8" * 64, {
        "plan_id": "api-recovery", "error": "automation_blocked",
    })
    client = TestClient(create_app(cfg, db))
    headers = AUTH_HEADERS

    chapter = client.get(f"/api/v1/books/{row['book_id']}/chapters/8", headers=headers).json()
    assert chapter["recovery"]["allowed"] is True
    assert chapter["recovery"]["last_checkpoint"] == "next_clicked"
    response = client.post(
        f"/api/v1/books/{row['book_id']}/chapters/8/recover-unsubmitted",
        headers=headers,
        json={
            "text_sha256": "8" * 64,
            "acknowledgement": "platform_checked_chapter_absent",
            "platform_found": False,
            "evidence_url": "https://fanqienovel.com/main/writer/chapter-manage/1234567890123",
        },
    )
    assert response.status_code == 200
    assert response.json()["chapter"]["status"] == "ready"
