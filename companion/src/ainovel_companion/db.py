from __future__ import annotations

import json
import sqlite3
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterator

PLATFORM_PERSISTED_STATES = {
    "legacy_published",
    "legacy_draft",
    "saved_draft",
    "published",
    "verified",
}
EVENT_STATUS = {
    "synced": "synced",
    "filled": "filled",
    "human_checked": "human_checked",
    "saved_draft": "saved_draft",
    "published": "published",
    "verified": "verified",
    "reconcile_match": "saved_draft",
    "reconcile_conflict": "version_conflict",
}


def utc_now() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


class PublishingDB:
    def __init__(self, path: Path):
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.initialize()

    @contextmanager
    def connect(self) -> Iterator[sqlite3.Connection]:
        conn = sqlite3.connect(self.path)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA foreign_keys = ON")
        conn.execute("PRAGMA journal_mode = WAL")
        try:
            yield conn
            conn.commit()
        except Exception:
            conn.rollback()
            raise
        finally:
            conn.close()

    def initialize(self) -> None:
        with self.connect() as conn:
            conn.executescript(
                """
                CREATE TABLE IF NOT EXISTS books (
                    book_id TEXT PRIMARY KEY,
                    name TEXT NOT NULL,
                    last_sync_at TEXT,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                );

                CREATE TABLE IF NOT EXISTS chapters (
                    book_id TEXT NOT NULL,
                    chapter_no INTEGER NOT NULL,
                    title TEXT NOT NULL,
                    source_file TEXT NOT NULL,
                    source_sha256 TEXT NOT NULL,
                    text_sha256 TEXT NOT NULL,
                    char_count INTEGER NOT NULL,
                    line_count INTEGER NOT NULL,
                    version INTEGER NOT NULL DEFAULT 1,
                    status TEXT NOT NULL,
                    generated_at TEXT,
                    text_path TEXT NOT NULL,
                    zip_path TEXT,
                    duplicate_of INTEGER,
                    body TEXT NOT NULL,
                    platform_chapter_id TEXT,
                    platform_state TEXT,
                    verified_at TEXT,
                    last_error TEXT,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL,
                    PRIMARY KEY (book_id, chapter_no),
                    FOREIGN KEY (book_id) REFERENCES books(book_id)
                );

                CREATE TABLE IF NOT EXISTS events (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    book_id TEXT NOT NULL,
                    chapter_no INTEGER NOT NULL,
                    event_type TEXT NOT NULL,
                    text_sha256 TEXT NOT NULL,
                    payload_json TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    FOREIGN KEY (book_id, chapter_no) REFERENCES chapters(book_id, chapter_no)
                );

                CREATE INDEX IF NOT EXISTS idx_chapters_status
                    ON chapters(book_id, status, chapter_no);
                CREATE INDEX IF NOT EXISTS idx_events_chapter
                    ON events(book_id, chapter_no, id);
                """
            )

    @staticmethod
    def bootstrap_status(chapter_no: int) -> str:
        if chapter_no <= 3:
            return "legacy_published"
        if chapter_no == 4:
            return "legacy_draft"
        return "ready"

    @staticmethod
    def slugify_book(name: str) -> str:
        # Stable enough for the phase-one single-book boundary while preserving readability.
        cleaned = "-".join(name.strip().lower().split())
        return cleaned or "default-book"

    def upsert_manifest_entry(self, book_name: str, entry: dict[str, Any], body: str) -> dict[str, Any]:
        now = utc_now()
        book_id = self.slugify_book(book_name)
        chapter_no = int(entry["chapter_no"])
        with self.connect() as conn:
            conn.execute(
                """
                INSERT INTO books(book_id, name, created_at, updated_at)
                VALUES (?, ?, ?, ?)
                ON CONFLICT(book_id) DO UPDATE SET name=excluded.name, updated_at=excluded.updated_at
                """,
                (book_id, book_name, now, now),
            )
            existing = conn.execute(
                "SELECT * FROM chapters WHERE book_id=? AND chapter_no=?",
                (book_id, chapter_no),
            ).fetchone()
            if existing is None:
                status = self.bootstrap_status(chapter_no)
                version = 1
                created_at = now
            else:
                created_at = existing["created_at"]
                if existing["text_sha256"] == entry["text_sha256"]:
                    status = existing["status"]
                    version = existing["version"]
                else:
                    version = existing["version"] + 1
                    status = (
                        "version_conflict"
                        if existing["status"] in PLATFORM_PERSISTED_STATES or existing["status"] == "version_conflict"
                        else "ready"
                    )
                    conn.execute(
                        """
                        INSERT INTO events(book_id, chapter_no, event_type, text_sha256, payload_json, created_at)
                        VALUES (?, ?, 'source_version_changed', ?, ?, ?)
                        """,
                        (
                            book_id,
                            chapter_no,
                            entry["text_sha256"],
                            json.dumps(
                                {
                                    "previous_text_sha256": existing["text_sha256"],
                                    "previous_status": existing["status"],
                                    "new_version": version,
                                },
                                ensure_ascii=False,
                            ),
                            now,
                        ),
                    )
            conn.execute(
                """
                INSERT INTO chapters(
                    book_id, chapter_no, title, source_file, source_sha256, text_sha256,
                    char_count, line_count, version, status, generated_at, text_path, zip_path,
                    duplicate_of, body, created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(book_id, chapter_no) DO UPDATE SET
                    title=excluded.title,
                    source_file=excluded.source_file,
                    source_sha256=excluded.source_sha256,
                    text_sha256=excluded.text_sha256,
                    char_count=excluded.char_count,
                    line_count=excluded.line_count,
                    version=excluded.version,
                    status=excluded.status,
                    generated_at=excluded.generated_at,
                    text_path=excluded.text_path,
                    zip_path=excluded.zip_path,
                    duplicate_of=excluded.duplicate_of,
                    body=excluded.body,
                    updated_at=excluded.updated_at
                """,
                (
                    book_id,
                    chapter_no,
                    entry["title"],
                    entry["source_file"],
                    entry["source_sha256"],
                    entry["text_sha256"],
                    int(entry.get("char_count", len(body))),
                    int(entry.get("line_count", len(body.splitlines()))),
                    version,
                    status,
                    entry.get("generated_at"),
                    entry["text_path"],
                    entry.get("zip_path"),
                    entry.get("duplicate_of"),
                    body,
                    created_at,
                    now,
                ),
            )
            row = conn.execute(
                "SELECT * FROM chapters WHERE book_id=? AND chapter_no=?",
                (book_id, chapter_no),
            ).fetchone()
            return dict(row)

    def mark_sync_complete(self, book_name: str) -> None:
        now = utc_now()
        book_id = self.slugify_book(book_name)
        with self.connect() as conn:
            conn.execute(
                "UPDATE books SET last_sync_at=?, updated_at=? WHERE book_id=?",
                (now, now, book_id),
            )

    def has_current_version(self, book_name: str, chapter_no: int, text_sha256: str) -> bool:
        book_id = self.slugify_book(book_name)
        with self.connect() as conn:
            row = conn.execute(
                "SELECT 1 FROM chapters WHERE book_id=? AND chapter_no=? AND text_sha256=?",
                (book_id, chapter_no, text_sha256),
            ).fetchone()
            return row is not None

    def list_books(self) -> list[dict[str, Any]]:
        with self.connect() as conn:
            rows = conn.execute(
                """
                SELECT b.*, COUNT(c.chapter_no) AS chapter_count,
                       SUM(CASE WHEN c.status='ready' THEN 1 ELSE 0 END) AS ready_count,
                       SUM(CASE WHEN c.status='version_conflict' THEN 1 ELSE 0 END) AS conflict_count
                FROM books b LEFT JOIN chapters c ON c.book_id=b.book_id
                GROUP BY b.book_id ORDER BY b.name
                """
            ).fetchall()
            return [dict(row) for row in rows]

    def list_chapters(self, book_id: str, status: str | None = None, after: int = 0, limit: int = 500) -> list[dict[str, Any]]:
        clauses = ["book_id=?", "chapter_no>?"]
        params: list[Any] = [book_id, after]
        if status:
            clauses.append("status=?")
            params.append(status)
        params.append(min(max(limit, 1), 1000))
        sql = f"""
            SELECT book_id, chapter_no, title, source_sha256, text_sha256, char_count,
                   line_count, version, status, generated_at, duplicate_of, platform_state,
                   verified_at, last_error, updated_at
            FROM chapters WHERE {' AND '.join(clauses)}
            ORDER BY chapter_no LIMIT ?
        """
        with self.connect() as conn:
            return [dict(row) for row in conn.execute(sql, params).fetchall()]

    def get_chapter(self, book_id: str, chapter_no: int) -> dict[str, Any] | None:
        with self.connect() as conn:
            row = conn.execute(
                "SELECT * FROM chapters WHERE book_id=? AND chapter_no=?",
                (book_id, chapter_no),
            ).fetchone()
            return dict(row) if row else None

    def record_event(
        self,
        book_id: str,
        chapter_no: int,
        event_type: str,
        text_sha256: str,
        payload: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        payload = payload or {}
        now = utc_now()
        with self.connect() as conn:
            chapter = conn.execute(
                "SELECT * FROM chapters WHERE book_id=? AND chapter_no=?",
                (book_id, chapter_no),
            ).fetchone()
            if chapter is None:
                raise KeyError("chapter_not_found")
            if chapter["text_sha256"] != text_sha256:
                raise ValueError("stale_chapter_version")
            new_status = EVENT_STATUS.get(event_type, chapter["status"])
            platform_state = payload.get("platform_state", chapter["platform_state"])
            platform_chapter_id = payload.get("platform_chapter_id", chapter["platform_chapter_id"])
            verified_at = now if event_type in {"saved_draft", "published", "verified", "reconcile_match"} else chapter["verified_at"]
            last_error = payload.get("error") if event_type == "failed" else None
            conn.execute(
                """
                INSERT INTO events(book_id, chapter_no, event_type, text_sha256, payload_json, created_at)
                VALUES (?, ?, ?, ?, ?, ?)
                """,
                (book_id, chapter_no, event_type, text_sha256, json.dumps(payload, ensure_ascii=False), now),
            )
            conn.execute(
                """
                UPDATE chapters
                SET status=?, platform_state=?, platform_chapter_id=?, verified_at=?, last_error=?, updated_at=?
                WHERE book_id=? AND chapter_no=?
                """,
                (new_status, platform_state, platform_chapter_id, verified_at, last_error, now, book_id, chapter_no),
            )
            updated = conn.execute(
                "SELECT * FROM chapters WHERE book_id=? AND chapter_no=?",
                (book_id, chapter_no),
            ).fetchone()
            return dict(updated)

    def list_events(self, book_id: str, chapter_no: int) -> list[dict[str, Any]]:
        with self.connect() as conn:
            rows = conn.execute(
                "SELECT * FROM events WHERE book_id=? AND chapter_no=? ORDER BY id",
                (book_id, chapter_no),
            ).fetchall()
            result = []
            for row in rows:
                item = dict(row)
                item["payload"] = json.loads(item.pop("payload_json"))
                result.append(item)
            return result
