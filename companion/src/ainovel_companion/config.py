from __future__ import annotations

import json
import os
import secrets
from dataclasses import dataclass
from pathlib import Path

APP_DIR_NAME = "AinovelPublisher"


def default_app_dir() -> Path:
    local_app_data = os.environ.get("LOCALAPPDATA")
    if local_app_data:
        return Path(local_app_data) / APP_DIR_NAME
    return Path.home() / ".ainovel-publisher"


def default_config_path() -> Path:
    override = os.environ.get("AINOVEL_PUBLISHER_CONFIG")
    return Path(override).expanduser() if override else default_app_dir() / "config.json"


def expand_path(value: str) -> Path:
    return Path(os.path.expandvars(value)).expanduser()


@dataclass(frozen=True)
class SSHConfig:
    host: str
    port: int
    username: str
    key_path: Path | None
    known_hosts_path: Path | None
    connect_timeout_seconds: int


@dataclass(frozen=True)
class RemoteConfig:
    export_command: str
    manifest_path: str
    release_root: str


@dataclass(frozen=True)
class APIConfig:
    host: str
    port: int
    token: str


@dataclass(frozen=True)
class PublicationConfig:
    timezone: str
    daily_limit: int
    default_slot: str
    slots: tuple[str, ...]
    default_ai_policy: str
    automation_enabled: bool


@dataclass(frozen=True)
class AppConfig:
    config_path: Path
    data_dir: Path
    database_path: Path
    ssh: SSHConfig
    remote: RemoteConfig
    api: APIConfig
    publication: PublicationConfig | None = None


def build_default_config() -> dict:
    app_dir = default_app_dir()
    return {
        "data_dir": str(app_dir),
        "database_path": str(app_dir / "publisher.db"),
        "ssh": {
            "host": "your-server.example.com",
            "port": 22,
            "username": "deploy",
            "key_path": "%USERPROFILE%\\.ssh\\id_ed25519",
            "known_hosts_path": "%USERPROFILE%\\.ssh\\known_hosts",
            "connect_timeout_seconds": 10,
        },
        "remote": {
            "export_command": "python3 /opt/ainovel/export_fanqie.py",
            "manifest_path": "/opt/ainovel/export/release/example-novel/manifest.jsonl",
            "release_root": "/opt/ainovel/export/release/example-novel",
        },
        "api": {
            "host": "127.0.0.1",
            "port": 8787,
            "token": secrets.token_urlsafe(32),
        },
        "publication": {
            "timezone": "Asia/Shanghai",
            "daily_limit": 9999,
            "default_slot": "20:00",
            "slots": ["12:00", "20:00", "22:00"],
            "default_ai_policy": "remember",
            "automation_enabled": False,
        },
    }


def initialize_config(path: Path | None = None, overwrite: bool = False) -> Path:
    target = path or default_config_path()
    if target.exists() and not overwrite:
        return target
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(json.dumps(build_default_config(), ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return target


def load_config(path: Path | None = None) -> AppConfig:
    target = path or default_config_path()
    if not target.exists():
        raise FileNotFoundError(f"Config does not exist: {target}. Run `ainovel-publisher init` first.")
    raw = json.loads(target.read_text(encoding="utf-8"))
    data_dir = expand_path(raw["data_dir"])
    database_path = expand_path(raw.get("database_path") or str(data_dir / "publisher.db"))
    ssh_raw = raw["ssh"]
    remote_raw = raw["remote"]
    api_raw = raw["api"]
    publication_raw = raw.get("publication") or {}
    slots = tuple(str(item) for item in publication_raw.get("slots", ["12:00", "20:00", "22:00"]))
    publication = PublicationConfig(
        timezone=str(publication_raw.get("timezone", "Asia/Shanghai")),
        daily_limit=int(publication_raw.get("daily_limit", 9999)),
        default_slot=str(publication_raw.get("default_slot", "20:00")),
        slots=slots,
        default_ai_policy=str(publication_raw.get("default_ai_policy", "remember")),
        automation_enabled=bool(publication_raw.get("automation_enabled", False)),
    )
    key_path = ssh_raw.get("key_path")
    known_hosts_path = ssh_raw.get("known_hosts_path")
    return AppConfig(
        config_path=target,
        data_dir=data_dir,
        database_path=database_path,
        ssh=SSHConfig(
            host=str(ssh_raw["host"]),
            port=int(ssh_raw.get("port", 22)),
            username=str(ssh_raw["username"]),
            key_path=expand_path(key_path) if key_path else None,
            known_hosts_path=expand_path(known_hosts_path) if known_hosts_path else None,
            connect_timeout_seconds=int(ssh_raw.get("connect_timeout_seconds", 10)),
        ),
        remote=RemoteConfig(
            export_command=str(remote_raw["export_command"]),
            manifest_path=str(remote_raw["manifest_path"]),
            release_root=str(remote_raw["release_root"]).rstrip("/"),
        ),
        api=APIConfig(
            host=str(api_raw.get("host", "127.0.0.1")),
            port=int(api_raw.get("port", 8787)),
            token=str(api_raw["token"]),
        ),
        publication=publication,
    )
