from __future__ import annotations

import json
import re
import sqlite3
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterator

PLATFORM_PERSISTED_STATES = {
    "legacy_published",
    "legacy_draft",
    "filled",
    "saved_draft",
    "awaiting_ai_choice",
    "submitted",
    "scheduled",
    "published",
    "verified",
    "blocked",
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
    "planned": "planned",
    "plan_approved": "planned",
    "final_submit_armed": "submitted",
    "schedule_submitted": "submitted",
    "submission_rejected": "blocked",
    "schedule_rescheduled": "scheduled",
    "schedule_verified": "scheduled",
    "awaiting_ai_choice": "awaiting_ai_choice",
    # Observation events prove that a platform row exists, but deliberately do not
    # claim that its body matches the current source chapter version.
    "schedule_observed": None,
    "published_observed": None,
    "platform_record_observed": None,
    "blocked": "blocked",
    "resumed": "planned",
}

RESUME_ACKNOWLEDGEMENT = "platform_checked_no_submission"
RECOVER_UNSUBMITTED_ACKNOWLEDGEMENT = "platform_checked_chapter_absent"
PLATFORM_STATES_REQUIRING_RECONCILIATION = {
    "scheduled",
    "published",
    "scheduled_unverified",
    "published_unverified",
    "submitted",
    "submitted_unverified",
}
PRE_MUTATION_RESUMABLE_REASONS = {
    "login_required",
    "work_identity_mismatch",
    "unknown_page_state",
}
FINAL_SUBMISSION_CHECKPOINTS = {
    "final_submit_armed",
    "final_submit_clicked",
    "schedule_submitted",
    "schedule_rescheduled",
    "schedule_verified",
    "published",
    "verified",
}
RECOVERABLE_CHECKPOINTS = {
    "automation_started",
    "filled",
    "next_clicked",
    "awaiting_ai_choice",
}

_CHAPTER_TITLE_PREFIX = re.compile(
    r"^第\s*[〇零一二三四五六七八九十百千万两\d]+\s*章[\s:：、.．-]*",
    re.UNICODE,
)
_CHINESE_DIGITS = "零一二三四五六七八九"


def fanqie_title_base(title: str) -> str:
    """Return the title text Fanqie's separate chapter-number field does not own."""
    return _CHAPTER_TITLE_PREFIX.sub("", str(title or "")).strip()


def _chinese_ordinal(value: int) -> str:
    if value < 10:
        return _CHINESE_DIGITS[value]
    if value == 10:
        return "十"
    if value < 20:
        return f"十{_CHINESE_DIGITS[value % 10]}"
    if value < 100:
        tail = "" if value % 10 == 0 else _CHINESE_DIGITS[value % 10]
        return f"{_CHINESE_DIGITS[value // 10]}十{tail}"
    return str(value)


def fanqie_platform_title(title: str, earlier_titles: list[str]) -> str:
    """Make a stable, minimally changed title when Fanqie forbids duplicates.

    The source manuscript remains untouched. Only the second and later occurrence gets
    a suffix, so ``晨钟`` becomes ``晨钟（二）`` and the first published title stays as-is.
    """
    base = fanqie_title_base(title)
    key = "".join(base.split())
    occurrence = 1 + sum(
        1 for previous in earlier_titles
        if "".join(fanqie_title_base(previous).split()) == key
    )
    return base if occurrence == 1 else f"{base}（{_chinese_ordinal(occurrence)}）"


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

                CREATE TABLE IF NOT EXISTS publication_plans (
                    plan_id TEXT PRIMARY KEY,
                    book_id TEXT NOT NULL,
                    timezone TEXT NOT NULL,
                    daily_limit INTEGER NOT NULL,
                    default_slot TEXT NOT NULL,
                    ai_policy TEXT NOT NULL,
                    status TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    approved_at TEXT,
                    updated_at TEXT NOT NULL,
                    FOREIGN KEY (book_id) REFERENCES books(book_id)
                );

                CREATE TABLE IF NOT EXISTS publication_plan_items (
                    plan_id TEXT NOT NULL,
                    book_id TEXT NOT NULL,
                    chapter_no INTEGER NOT NULL,
                    text_sha256 TEXT NOT NULL,
                    title TEXT NOT NULL,
                    quota_units INTEGER NOT NULL,
                    publication_date TEXT,
                    publication_time TEXT,
                    status TEXT NOT NULL,
                    reason TEXT,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL,
                    PRIMARY KEY (plan_id, chapter_no),
                    FOREIGN KEY (plan_id) REFERENCES publication_plans(plan_id) ON DELETE CASCADE,
                    FOREIGN KEY (book_id, chapter_no) REFERENCES chapters(book_id, chapter_no)
                );

                CREATE INDEX IF NOT EXISTS idx_plan_items_book
                    ON publication_plan_items(book_id, status, chapter_no);
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
            if row is None:
                return None
            earlier_titles = [
                str(item["title"])
                for item in conn.execute(
                    "SELECT title FROM chapters WHERE book_id=? AND chapter_no<? ORDER BY chapter_no",
                    (book_id, chapter_no),
                ).fetchall()
            ]
            result = dict(row)
            result["platform_title"] = fanqie_platform_title(result["title"], earlier_titles)
            return result

    @staticmethod
    def _recovery_state_from_rows(
        chapter: sqlite3.Row | dict[str, Any],
        events: list[sqlite3.Row] | list[dict[str, Any]],
    ) -> dict[str, Any]:
        """Describe whether one stopped attempt can return to the new-chapter path.

        Clicking ``Next`` is not Fanqie's final publication mutation. A stopped run is
        recoverable after a chapter-list absence check until the final-submit action is
        armed. Once final submission may have been sent, only platform reconciliation
        can decide the outcome.
        """
        result: dict[str, Any] = {
            "allowed": False,
            "mode": None,
            "reason": "chapter_not_blocked",
            "last_checkpoint": None,
            "plan_id": None,
        }
        if chapter["status"] != "blocked":
            return result
        if chapter["platform_state"] in PLATFORM_STATES_REQUIRING_RECONCILIATION:
            result["reason"] = "platform_state_requires_reconciliation"
            return result

        current_events = [row for row in events if row["text_sha256"] == chapter["text_sha256"]]
        attempt_start = 0
        for index, row in enumerate(current_events):
            if row["event_type"] == "automation_started":
                attempt_start = index
        attempt_events = current_events[attempt_start:]

        for row in reversed(attempt_events):
            try:
                payload = json.loads(row["payload_json"] or "{}")
            except (TypeError, json.JSONDecodeError):
                payload = {}
            if not result["plan_id"] and payload.get("plan_id"):
                result["plan_id"] = str(payload["plan_id"])

        final_event = next(
            (row for row in reversed(attempt_events) if row["event_type"] in FINAL_SUBMISSION_CHECKPOINTS),
            None,
        )
        if final_event:
            result.update(
                reason="final_submission_requires_reconciliation",
                last_checkpoint=final_event["event_type"],
            )
            return result

        checkpoint = next(
            (row["event_type"] for row in reversed(attempt_events) if row["event_type"] in RECOVERABLE_CHECKPOINTS),
            "preflight",
        )
        result.update(
            allowed=True,
            mode="recover_unsubmitted",
            reason="platform_absence_check_required",
            last_checkpoint=checkpoint,
        )
        return result

    def get_chapter_recovery(self, book_id: str, chapter_no: int) -> dict[str, Any]:
        with self.connect() as conn:
            chapter = conn.execute(
                "SELECT * FROM chapters WHERE book_id=? AND chapter_no=?",
                (book_id, chapter_no),
            ).fetchone()
            if chapter is None:
                raise KeyError("chapter_not_found")
            events = conn.execute(
                "SELECT * FROM events WHERE book_id=? AND chapter_no=? ORDER BY id",
                (book_id, chapter_no),
            ).fetchall()
            return self._recovery_state_from_rows(chapter, list(events))

    def recover_unsubmitted_chapter(
        self,
        book_id: str,
        chapter_no: int,
        text_sha256: str,
        *,
        acknowledgement: str,
        platform_found: bool,
        evidence_url: str | None = None,
    ) -> dict[str, Any]:
        """Recover a stopped pre-final-submit attempt after a live absence check."""
        if acknowledgement != RECOVER_UNSUBMITTED_ACKNOWLEDGEMENT:
            raise ValueError("recovery_acknowledgement_required")
        if platform_found is not False:
            raise ValueError("platform_record_requires_reconciliation")

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
            events = conn.execute(
                "SELECT * FROM events WHERE book_id=? AND chapter_no=? ORDER BY id",
                (book_id, chapter_no),
            ).fetchall()
            recovery = self._recovery_state_from_rows(chapter, list(events))
            if not recovery["allowed"]:
                raise ValueError(str(recovery["reason"]))

            active_plans = conn.execute(
                """
                SELECT plan_id FROM publication_plans
                WHERE book_id=? AND status IN ('draft', 'approved')
                ORDER BY created_at
                """,
                (book_id,),
            ).fetchall()
            superseded_plan_ids = [str(row["plan_id"]) for row in active_plans]
            payload = {
                "acknowledgement": acknowledgement,
                "platform_found": False,
                "evidence_url": evidence_url,
                "last_checkpoint": recovery["last_checkpoint"],
                "plan_id": recovery["plan_id"],
            }
            for event_type in ("platform_absence_observed", "recovered_unsubmitted"):
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
                SET status='ready', platform_state=NULL, platform_chapter_id=NULL,
                    verified_at=NULL, last_error=NULL, updated_at=?
                WHERE book_id=? AND chapter_no=?
                """,
                (now, book_id, chapter_no),
            )
            conn.execute(
                """
                UPDATE publication_plans
                SET status='superseded', updated_at=?
                WHERE book_id=? AND status IN ('draft', 'approved')
                """,
                (now, book_id),
            )

        chapter_result = self.get_chapter(book_id, chapter_no)
        if chapter_result is None:  # Defensive: the transaction verified this row.
            raise KeyError("chapter_not_found")
        return {
            "chapter": chapter_result,
            "recovery": self.get_chapter_recovery(book_id, chapter_no),
            "superseded_plan_ids": superseded_plan_ids,
        }

    def list_plan_candidates(self, book_id: str) -> list[dict[str, Any]]:
        with self.connect() as conn:
            rows = conn.execute(
                """
                SELECT book_id, chapter_no, title, text_sha256, char_count, body, version, status,
                       platform_state, updated_at
                FROM chapters
                WHERE book_id=? AND status IN (
                    'ready', 'synced', 'fill_started', 'filled', 'saved_draft',
                    'awaiting_ai_choice', 'submitted', 'legacy_draft',
                    'version_conflict', 'blocked'
                )
                ORDER BY chapter_no
                """,
                (book_id,),
            ).fetchall()
            return [dict(row) for row in rows]

    def list_verified_schedules(self, book_id: str) -> list[dict[str, Any]]:
        """Return latest platform schedule evidence, including unverified versions.

        ``verified`` means the schedule row/date was read from the platform.
        ``version_verified`` separately means the platform body was matched to the
        immutable local chapter hash. Keeping these separate prevents chapter-number
        matches from being treated as content verification.
        """
        with self.connect() as conn:
            rows = conn.execute(
                """
                SELECT e.chapter_no, e.text_sha256, e.event_type, e.payload_json, e.created_at
                FROM events e
                WHERE e.book_id=? AND e.event_type IN (
                    'schedule_observed', 'published_observed',
                    'schedule_rescheduled', 'schedule_verified', 'published', 'verified'
                )
                ORDER BY e.chapter_no, e.id
                """,
                (book_id,),
            ).fetchall()
        latest: dict[int, dict[str, Any]] = {}
        for row in rows:
            payload = json.loads(row["payload_json"] or "{}")
            if not payload.get("publication_date"):
                continue
            version_verified = bool(
                payload.get(
                    "version_verified",
                    row["event_type"] not in {"schedule_observed", "published_observed"},
                )
            )
            if row["event_type"] in {"schedule_observed", "schedule_rescheduled", "schedule_verified"}:
                platform_state = "scheduled"
            else:
                platform_state = "published"
            latest[int(row["chapter_no"])] = {
                "chapter_no": int(row["chapter_no"]),
                "text_sha256": row["text_sha256"] if version_verified else None,
                "publication_date": str(payload["publication_date"]),
                "publication_time": payload.get("publication_time"),
                "quota_units": int(payload.get("quota_units") or 0),
                "verified": True,
                "version_verified": version_verified,
                "platform_state": platform_state,
            }
        return list(latest.values())

    def create_publication_plan(
        self,
        book_id: str,
        *,
        timezone: str,
        daily_limit: int,
        default_slot: str,
        ai_policy: str,
        items: list[dict[str, Any]],
        plan_id: str,
    ) -> dict[str, Any]:
        now = utc_now()
        with self.connect() as conn:
            book = conn.execute("SELECT 1 FROM books WHERE book_id=?", (book_id,)).fetchone()
            if book is None:
                raise KeyError("book_not_found")
            # A proposal is a replaceable snapshot. Keeping dozens of active drafts made
            # the side panel expose stale blockers, so only the newest draft stays active.
            conn.execute(
                """
                UPDATE publication_plans SET status='superseded', updated_at=?
                WHERE book_id=? AND status='draft'
                """,
                (now, book_id),
            )
            conn.execute(
                """
                INSERT INTO publication_plans(
                    plan_id, book_id, timezone, daily_limit, default_slot, ai_policy,
                    status, created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, 'draft', ?, ?)
                """,
                (plan_id, book_id, timezone, daily_limit, default_slot, ai_policy, now, now),
            )
            for item in items:
                conn.execute(
                    """
                    INSERT INTO publication_plan_items(
                        plan_id, book_id, chapter_no, text_sha256, title, quota_units,
                        publication_date, publication_time, status, reason, created_at, updated_at
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        plan_id, book_id, int(item["chapter_no"]), str(item["text_sha256"]),
                        str(item.get("title") or ""), int(item.get("quota_units") or 0),
                        item.get("publication_date"), item.get("publication_time"),
                        str(item.get("status") or "planned"), item.get("reason"), now, now,
                    ),
                )
        return self.get_publication_plan(plan_id)

    def get_publication_plan(self, plan_id: str) -> dict[str, Any] | None:
        with self.connect() as conn:
            plan_row = conn.execute(
                "SELECT * FROM publication_plans WHERE plan_id=?", (plan_id,)
            ).fetchone()
            if plan_row is None:
                return None
            item_rows = conn.execute(
                """
                SELECT * FROM publication_plan_items
                WHERE plan_id=? ORDER BY chapter_no
                """,
                (plan_id,),
            ).fetchall()
        result = dict(plan_row)
        result["items"] = [dict(row) for row in item_rows]
        return result

    def list_publication_plans(self, book_id: str, limit: int = 20) -> list[dict[str, Any]]:
        with self.connect() as conn:
            rows = conn.execute(
                "SELECT plan_id FROM publication_plans WHERE book_id=? ORDER BY created_at DESC LIMIT ?",
                (book_id, min(max(limit, 1), 100)),
            ).fetchall()
        return [self.get_publication_plan(row["plan_id"]) for row in rows]

    def approve_publication_plan(self, plan_id: str) -> dict[str, Any]:
        now = utc_now()
        with self.connect() as conn:
            row = conn.execute("SELECT * FROM publication_plans WHERE plan_id=?", (plan_id,)).fetchone()
            if row is None:
                raise KeyError("plan_not_found")
            if row["status"] == "approved":
                return self.get_publication_plan(plan_id)
            if row["status"] != "draft":
                raise ValueError("plan_not_approvable")
            blocked = conn.execute(
                "SELECT 1 FROM publication_plan_items WHERE plan_id=? AND status='blocked' LIMIT 1",
                (plan_id,),
            ).fetchone()
            if blocked:
                raise ValueError("plan_contains_blocked_items")
            # Exactly one approved plan may drive a work. Chapter state and platform
            # observations are canonical, so a newly approved snapshot safely replaces
            # older pre-submission work instead of creating parallel runners.
            conn.execute(
                """
                UPDATE publication_plans SET status='superseded', updated_at=?
                WHERE book_id=? AND status='approved' AND plan_id<>?
                """,
                (now, row["book_id"], plan_id),
            )
            conn.execute(
                "UPDATE publication_plans SET status='approved', approved_at=?, updated_at=? WHERE plan_id=?",
                (now, now, plan_id),
            )
        return self.get_publication_plan(plan_id)

    def update_plan_item_status(self, plan_id: str, chapter_no: int, status: str, reason: str | None = None) -> None:
        with self.connect() as conn:
            conn.execute(
                """
                UPDATE publication_plan_items
                SET status=?, reason=?, updated_at=?
                WHERE plan_id=? AND chapter_no=?
                """,
                (status, reason, utc_now(), plan_id, chapter_no),
            )

    def resume_plan_item(
        self,
        plan_id: str,
        chapter_no: int,
        text_sha256: str,
        *,
        acknowledgement: str,
    ) -> dict[str, Any]:
        """Reopen one runtime-blocked item after an explicit platform check.

        This deliberately cannot clear planning-time conflicts or an ambiguous platform
        state. Those must be reconciled with Fanqie first so a retry cannot create a
        duplicate chapter or schedule.
        """
        if acknowledgement != RESUME_ACKNOWLEDGEMENT:
            raise ValueError("resume_acknowledgement_required")

        now = utc_now()
        with self.connect() as conn:
            plan = conn.execute(
                "SELECT * FROM publication_plans WHERE plan_id=?", (plan_id,)
            ).fetchone()
            if plan is None:
                raise KeyError("plan_not_found")
            if plan["status"] != "approved":
                raise ValueError("plan_not_approved")

            item = conn.execute(
                "SELECT * FROM publication_plan_items WHERE plan_id=? AND chapter_no=?",
                (plan_id, chapter_no),
            ).fetchone()
            if item is None:
                raise KeyError("plan_item_not_found")
            if item["status"] != "blocked":
                raise ValueError("plan_item_not_blocked")
            if item["text_sha256"] != text_sha256:
                raise ValueError("stale_plan_item_version")

            chapter = conn.execute(
                "SELECT * FROM chapters WHERE book_id=? AND chapter_no=?",
                (plan["book_id"], chapter_no),
            ).fetchone()
            if chapter is None:
                raise KeyError("chapter_not_found")
            if chapter["text_sha256"] != text_sha256:
                raise ValueError("stale_chapter_version")
            if chapter["status"] != "blocked":
                raise ValueError("chapter_not_blocked")
            if chapter["platform_state"] in PLATFORM_STATES_REQUIRING_RECONCILIATION:
                raise ValueError("platform_state_requires_reconciliation")
            if item["reason"] not in PRE_MUTATION_RESUMABLE_REASONS:
                raise ValueError("blocked_stage_requires_reconciliation")

            payload = {
                "plan_id": plan_id,
                "acknowledgement": acknowledgement,
                "previous_error": chapter["last_error"],
                "previous_reason": item["reason"],
            }
            conn.execute(
                """
                INSERT INTO events(book_id, chapter_no, event_type, text_sha256, payload_json, created_at)
                VALUES (?, ?, 'resumed', ?, ?, ?)
                """,
                (
                    plan["book_id"],
                    chapter_no,
                    text_sha256,
                    json.dumps(payload, ensure_ascii=False),
                    now,
                ),
            )
            conn.execute(
                """
                UPDATE chapters
                SET status='planned', last_error=NULL, updated_at=?
                WHERE book_id=? AND chapter_no=?
                """,
                (now, plan["book_id"], chapter_no),
            )
            conn.execute(
                """
                UPDATE publication_plan_items
                SET status='planned', reason=NULL, updated_at=?
                WHERE plan_id=? AND chapter_no=?
                """,
                (now, plan_id, chapter_no),
            )
            conn.execute(
                "UPDATE publication_plans SET updated_at=? WHERE plan_id=?",
                (now, plan_id),
            )
        result = self.get_publication_plan(plan_id)
        if result is None:  # Defensive: the row was present in the transaction above.
            raise KeyError("plan_not_found")
        return result

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
            mapped_status = EVENT_STATUS.get(event_type)
            new_status = mapped_status or chapter["status"]
            platform_state = payload.get("platform_state", chapter["platform_state"])
            platform_chapter_id = payload.get("platform_chapter_id", chapter["platform_chapter_id"])
            verified_at = now if event_type in {"saved_draft", "published", "verified", "reconcile_match", "schedule_rescheduled", "schedule_verified"} else chapter["verified_at"]
            if event_type in {"failed", "blocked", "submission_rejected"}:
                last_error = payload.get("error") or event_type
            elif event_type in {"resumed", "schedule_rescheduled", "schedule_verified", "published", "verified", "reconcile_match"}:
                last_error = None
            else:
                last_error = chapter["last_error"]
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
            plan_id = payload.get("plan_id")
            if plan_id:
                plan_status = {
                    "planned": "planned",
                    "plan_approved": "planned",
                    "final_submit_armed": "submitted",
                    "schedule_submitted": "submitted",
                    "submission_rejected": "blocked",
                    "schedule_rescheduled": "scheduled",
                    "schedule_verified": "scheduled",
                    "awaiting_ai_choice": "awaiting_ai_choice",
                    "published": "published",
                    "blocked": "blocked",
                    "resumed": "planned",
                }.get(event_type)
                if plan_status:
                    conn.execute(
                        """
                        UPDATE publication_plan_items
                        SET status=?, reason=?, updated_at=?
                        WHERE plan_id=? AND chapter_no=?
                        """,
                        (plan_status, payload.get("error"), now, plan_id, chapter_no),
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
