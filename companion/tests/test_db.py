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


def test_changed_published_version_becomes_conflict(tmp_path: Path):
    db = PublishingDB(tmp_path / "publisher.db")
    row = db.upsert_manifest_entry("示例小说", entry(5, "5" * 64), "old")
    book_id = row["book_id"]
    db.record_event(book_id, 5, "published", "5" * 64, {"platform_state": "published"})
    changed = db.upsert_manifest_entry("示例小说", entry(5, "6" * 64), "new")
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
