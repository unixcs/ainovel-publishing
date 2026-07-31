#!/usr/bin/env python3
from __future__ import annotations

import glob
import hashlib
import json
import os
import re
import shutil
import sys
import time
import zipfile
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterable

SRC = Path(os.environ.get("AINOVEL_SOURCE_ROOT", "/opt/ainovel/workspace/output/novel"))
OUT = Path(os.environ.get("AINOVEL_EXPORT_ROOT", "/opt/ainovel/export"))
PROGRESS = SRC / "meta" / "progress.json"
STABLE_POLLS = 2
STABLE_INTERVAL = 1
STABLE_MIN_AGE_SECONDS = 10
MAX_TITLE_LEN = 80
PLAIN_CHAPTER_TITLE = re.compile(
    r"^第\s*(?:\d+|[零〇一二三四五六七八九十百千两]+)\s*章(?:\s+|[：:]\s*)\S.{0,60}$"
)


def utc_now() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def load_json(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def safe_filename(name: str, limit: int = 80) -> str:
    cleaned = re.sub(r'[\\/:*?"<>|\r\n]+', '_', name).strip().strip('.')
    cleaned = re.sub(r'\s+', ' ', cleaned)
    return (cleaned or "untitled")[:limit]


def chapter_number_from_path(path: Path) -> int:
    match = re.search(r'(\d+)', path.stem)
    if not match:
        raise ValueError(f"cannot parse chapter number from {path}")
    return int(match.group(1))


def sha256_text(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def clean_line(line: str) -> str:
    line = re.sub(r'!\[[^\]]*\]\([^)]*\)', '', line)
    line = re.sub(r'\[([^\]]+)\]\([^)]*\)', r'\1', line)
    line = re.sub(r'\*\*(.+?)\*\*', r'\1', line)
    line = re.sub(r'\*(.+?)\*', r'\1', line)
    line = re.sub(r'`([^`]+)`', r'\1', line)
    line = re.sub(r'^>\s?', '', line)
    return line


def parse_markdown_chapter(path: Path, fallback_title: str) -> tuple[str, str]:
    raw = path.read_text(encoding='utf-8').lstrip('\ufeff').splitlines()
    title = None
    body: list[str] = []
    first_content_seen = False
    for line in raw:
        s = line.strip()
        if not first_content_seen and not s:
            continue
        if not first_content_seen:
            first_content_seen = True
            if s.startswith('#'):
                title = clean_line(re.sub(r'^#{1,6}\s+', '', s)).strip()
                continue
            # Some Ainovel chapters use a plain first-line heading instead of Markdown.
            # Promote only a short, explicit “第…章 + title” line; ordinary prose stays body.
            plain_title = clean_line(s).strip()
            if PLAIN_CHAPTER_TITLE.fullmatch(plain_title):
                title = plain_title
                continue
        if s.startswith('#'):
            body.append(clean_line(re.sub(r'^#{1,6}\s+', '', s)))
            continue
        if re.fullmatch(r'-{3,}|\*{3,}|_{3,}', s):
            body.append('')
            continue
        body.append(clean_line(line.rstrip()))
    if not title:
        title = fallback_title

    cleaned: list[str] = []
    blank = False
    for item in body:
        if item.strip() == '':
            if not blank:
                cleaned.append('')
            blank = True
        else:
            cleaned.append(item)
            blank = False
    text = '\n'.join(cleaned).strip()
    return title.strip(), text


def wait_until_stable(path: Path, polls: int = STABLE_POLLS, interval: int = STABLE_INTERVAL) -> bool:
    try:
        stat = path.stat()
    except FileNotFoundError:
        return False

    if time.time() - stat.st_mtime >= STABLE_MIN_AGE_SECONDS:
        return True

    previous = (stat.st_size, int(stat.st_mtime))
    stable_hits = 1
    for _ in range(max(polls * 3, polls)):
        time.sleep(interval)
        try:
            stat = path.stat()
        except FileNotFoundError:
            return False
        current = (stat.st_size, int(stat.st_mtime))
        if current == previous:
            stable_hits += 1
            if stable_hits >= polls:
                return True
        else:
            stable_hits = 1
            previous = current
    return False


def parse_premise_sections(path: Path) -> dict[str, str]:
    if not path.exists():
        return {}
    sections: dict[str, str] = {}
    cur = None
    buf: list[str] = []
    for line in path.read_text(encoding='utf-8').splitlines():
        m = re.match(r'^##\s+(.*)', line)
        if m:
            if cur:
                sections[cur] = '\n'.join(buf).strip()
            cur = m.group(1)
            buf = []
        elif cur:
            buf.append(line.rstrip())
    if cur:
        sections[cur] = '\n'.join(buf).strip()
    return sections


def pick_section(sections: dict[str, str], *keys: str) -> str:
    for k, v in sections.items():
        for key in keys:
            if key in k:
                return v
    return ''


@dataclass
class ChapterArtifact:
    chapter_no: int
    title: str
    source_file: str
    source_sha256: str
    text_sha256: str
    char_count: int
    line_count: int
    status: str
    generated_at: str
    text_path: str
    zip_path: str
    duplicate_of: int | None
    body: str

    def to_manifest(self) -> dict:
        return {
            "chapter_no": self.chapter_no,
            "title": self.title,
            "source_file": self.source_file,
            "source_sha256": self.source_sha256,
            "text_sha256": self.text_sha256,
            "char_count": self.char_count,
            "line_count": self.line_count,
            "status": self.status,
            "generated_at": self.generated_at,
            "text_path": self.text_path,
            "zip_path": self.zip_path,
            "duplicate_of": self.duplicate_of,
        }


def main() -> int:
    if not PROGRESS.exists():
        raise SystemExit(f"missing progress file: {PROGRESS}")

    progress = load_json(PROGRESS)
    book = progress.get("novel_name") or "未命名作品"
    completed = {int(x) for x in progress.get("completed_chapters", [])}
    in_progress = progress.get("in_progress_chapter")
    generated_at = utc_now()

    legacy_chapters_dir = OUT / "chapters"
    release_root = OUT / "release" / safe_filename(book, 64)
    release_chapters_dir = release_root / "chapters"
    ready_dir = release_root / "ready"
    rejects_dir = release_root / "rejects"
    reports_dir = release_root / "reports"

    for path in [legacy_chapters_dir, release_chapters_dir, ready_dir, rejects_dir, reports_dir]:
        path.mkdir(parents=True, exist_ok=True)

    chapter_files = sorted((SRC / "chapters").glob("*.md"), key=chapter_number_from_path)
    if not chapter_files:
        raise SystemExit("no chapter files found")

    exported: list[ChapterArtifact] = []
    skipped: list[dict] = []
    duplicate_map: dict[str, int] = {}

    merged_lines: list[str] = []
    for src_file in chapter_files:
        chapter_no = chapter_number_from_path(src_file)
        if chapter_no not in completed:
            skipped.append({
                "chapter_no": chapter_no,
                "source_file": src_file.name,
                "reason": "not_completed_in_progress_json",
            })
            continue

        if not wait_until_stable(src_file):
            skipped.append({
                "chapter_no": chapter_no,
                "source_file": src_file.name,
                "reason": "file_not_stable",
            })
            continue

        fallback_title = f"第{chapter_no}章"
        title, body = parse_markdown_chapter(src_file, fallback_title)
        source_hash = sha256_file(src_file)
        text_hash = sha256_text(body)
        duplicate_of = duplicate_map.get(text_hash)
        if duplicate_of is None:
            duplicate_map[text_hash] = chapter_no

        safe_title = safe_filename(title, MAX_TITLE_LEN)
        base_name = f"{chapter_no:04d}_{safe_title}"
        legacy_name = f"{chapter_no:02d}_{safe_title}.txt"
        text_filename = f"{base_name}.txt"
        zip_filename = f"{base_name}.zip"

        text_content = f"{title}\n\n{body}\n"
        for target in [legacy_chapters_dir / legacy_name, release_chapters_dir / text_filename]:
            target.write_text(text_content, encoding="utf-8")

        zip_path = ready_dir / zip_filename
        with zipfile.ZipFile(zip_path, "w", compression=zipfile.ZIP_DEFLATED) as zf:
            zf.writestr(text_filename, text_content)

        artifact = ChapterArtifact(
            chapter_no=chapter_no,
            title=title,
            source_file=src_file.name,
            source_sha256=source_hash,
            text_sha256=text_hash,
            char_count=len(body),
            line_count=0 if not body else len(body.splitlines()),
            status="ready",
            generated_at=generated_at,
            text_path=str((release_chapters_dir / text_filename).relative_to(release_root)),
            zip_path=str(zip_path.relative_to(release_root)),
            duplicate_of=duplicate_of,
            body=body,
        )
        exported.append(artifact)
        merged_lines.extend([title, '', body, '', ''])

    if not exported:
        raise SystemExit("no completed and stable chapters eligible for export")

    manifest_path = release_root / "manifest.jsonl"
    manifest_path.write_text(
        '\n'.join(json.dumps(item.to_manifest(), ensure_ascii=False) for item in exported) + '\n',
        encoding='utf-8',
    )

    merged_book_path = OUT / f"{safe_filename(book, 64)}_全集.txt"
    merged_book_path.write_text('\n'.join(merged_lines), encoding='utf-8')

    sections = parse_premise_sections(SRC / "premise.md")
    intro = "\n".join(
        x for x in [
            pick_section(sections, '题材和基调'),
            pick_section(sections, '核心冲突'),
            pick_section(sections, '差异化钩子'),
        ] if x
    )
    copy_text = (
        f"书名：{book}\n"
        "品类：男频 - 玄幻（东方玄幻/修真）\n"
        "标签：东方玄幻、升级、热血、修炼、谋略、悬念、成长\n\n"
        f"简介：\n{intro}\n"
    )
    (OUT / "文案草稿.txt").write_text(copy_text, encoding='utf-8')

    batch_zip_path = release_root / "latest-batch.zip"
    with zipfile.ZipFile(batch_zip_path, "w", compression=zipfile.ZIP_DEFLATED) as zf:
        zf.write(manifest_path, arcname="manifest.jsonl")
        zf.write(merged_book_path, arcname=merged_book_path.name)
        zf.writestr("文案草稿.txt", copy_text)
        for artifact in exported:
            file_path = release_root / artifact.text_path
            zf.write(file_path, arcname=f"chapters/{Path(artifact.text_path).name}")

    report = {
        "generated_at": generated_at,
        "book": book,
        "source_dir": str(SRC),
        "output_dir": str(OUT),
        "release_root": str(release_root),
        "chapter_file_count": len(chapter_files),
        "completed_chapter_count": len(completed),
        "exported_count": len(exported),
        "skipped_count": len(skipped),
        "in_progress_chapter": in_progress,
        "latest_exported_chapter": exported[-1].chapter_no,
        "manifest_path": str(manifest_path),
        "batch_zip_path": str(batch_zip_path),
        "duplicates": [
            {
                "chapter_no": item.chapter_no,
                "duplicate_of": item.duplicate_of,
                "title": item.title,
            }
            for item in exported if item.duplicate_of is not None
        ],
        "skipped": skipped,
    }
    report_json_path = reports_dir / "latest-report.json"
    report_txt_path = reports_dir / "latest-report.txt"
    report_json_path.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding='utf-8')
    report_txt_path.write_text(
        "\n".join([
            f"book: {book}",
            f"generated_at: {generated_at}",
            f"source_dir: {SRC}",
            f"release_root: {release_root}",
            f"chapter_file_count: {len(chapter_files)}",
            f"completed_chapter_count: {len(completed)}",
            f"exported_count: {len(exported)}",
            f"skipped_count: {len(skipped)}",
            f"in_progress_chapter: {in_progress}",
            f"latest_exported_chapter: {exported[-1].chapter_no}",
            f"manifest_path: {manifest_path}",
            f"batch_zip_path: {batch_zip_path}",
            f"duplicate_count: {sum(1 for item in exported if item.duplicate_of is not None)}",
        ]) + "\n",
        encoding='utf-8',
    )

    if skipped:
        (rejects_dir / "latest-skipped.json").write_text(
            json.dumps(skipped, ensure_ascii=False, indent=2) + "\n",
            encoding='utf-8',
        )

    print(json.dumps({
        "book": book,
        "exported_count": len(exported),
        "skipped_count": len(skipped),
        "latest_exported_chapter": exported[-1].chapter_no,
        "manifest_path": str(manifest_path),
        "batch_zip_path": str(batch_zip_path),
        "report_path": str(report_json_path),
    }, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
