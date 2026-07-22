from __future__ import annotations

import json
import posixpath
from dataclasses import dataclass
from typing import Any

import paramiko

from .config import AppConfig
from .db import PublishingDB


class SyncError(RuntimeError):
    pass


@dataclass(frozen=True)
class SyncResult:
    book: str
    manifest_count: int
    downloaded_count: int
    unchanged_count: int
    conflict_count: int

    def to_dict(self) -> dict[str, Any]:
        return {
            "book": self.book,
            "manifest_count": self.manifest_count,
            "downloaded_count": self.downloaded_count,
            "unchanged_count": self.unchanged_count,
            "conflict_count": self.conflict_count,
        }


def split_release_text(text: str, manifest_title: str) -> str:
    normalized = text.replace("\r\n", "\n").replace("\r", "\n").lstrip("\ufeff")
    lines = normalized.split("\n")
    if lines and lines[0].strip() == manifest_title.strip():
        lines = lines[1:]
        while lines and not lines[0].strip():
            lines.pop(0)
    return "\n".join(lines).rstrip("\n")


class RemoteSynchronizer:
    def __init__(self, config: AppConfig, db: PublishingDB):
        self.config = config
        self.db = db

    def _connect(self) -> paramiko.SSHClient:
        ssh = paramiko.SSHClient()
        ssh.load_system_host_keys()
        if self.config.ssh.known_hosts_path and self.config.ssh.known_hosts_path.exists():
            ssh.load_host_keys(str(self.config.ssh.known_hosts_path))
        ssh.set_missing_host_key_policy(paramiko.RejectPolicy())
        kwargs: dict[str, Any] = {
            "hostname": self.config.ssh.host,
            "port": self.config.ssh.port,
            "username": self.config.ssh.username,
            "timeout": self.config.ssh.connect_timeout_seconds,
            "banner_timeout": self.config.ssh.connect_timeout_seconds,
            "auth_timeout": self.config.ssh.connect_timeout_seconds,
            "allow_agent": True,
            "look_for_keys": True,
        }
        if self.config.ssh.key_path:
            kwargs["key_filename"] = str(self.config.ssh.key_path)
        try:
            ssh.connect(**kwargs)
        except Exception as exc:
            ssh.close()
            raise SyncError(f"SSH connection failed: {exc}") from exc
        return ssh

    def sync(self, run_export: bool = True) -> SyncResult:
        ssh = self._connect()
        try:
            if run_export:
                _, stdout, stderr = ssh.exec_command(self.config.remote.export_command)
                exit_status = stdout.channel.recv_exit_status()
                error_text = stderr.read().decode("utf-8", errors="replace").strip()
                if exit_status != 0:
                    raise SyncError(f"Remote export failed ({exit_status}): {error_text}")
            sftp = ssh.open_sftp()
            try:
                with sftp.open(self.config.remote.manifest_path, "r") as fh:
                    manifest_text = fh.read().decode("utf-8")
                entries = [json.loads(line) for line in manifest_text.splitlines() if line.strip()]
                if not entries:
                    raise SyncError("Remote manifest is empty")
                book_name = self.config.remote.release_root.rsplit("/", 1)[-1]
                downloaded = 0
                unchanged = 0
                conflicts = 0
                for entry in entries:
                    chapter_no = int(entry["chapter_no"])
                    if self.db.has_current_version(book_name, chapter_no, entry["text_sha256"]):
                        unchanged += 1
                        continue
                    remote_text_path = posixpath.join(self.config.remote.release_root, entry["text_path"])
                    with sftp.open(remote_text_path, "r") as chapter_fh:
                        release_text = chapter_fh.read().decode("utf-8")
                    body = split_release_text(release_text, entry["title"])
                    row = self.db.upsert_manifest_entry(book_name, entry, body)
                    downloaded += 1
                    if row["status"] == "version_conflict":
                        conflicts += 1
                self.db.mark_sync_complete(book_name)
                return SyncResult(
                    book=book_name,
                    manifest_count=len(entries),
                    downloaded_count=downloaded,
                    unchanged_count=unchanged,
                    conflict_count=conflicts,
                )
            finally:
                sftp.close()
        except SyncError:
            raise
        except Exception as exc:
            raise SyncError(f"Remote synchronization failed: {exc}") from exc
        finally:
            ssh.close()
