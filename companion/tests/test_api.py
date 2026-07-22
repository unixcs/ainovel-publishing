from pathlib import Path

from fastapi.testclient import TestClient

from ainovel_companion.api import create_app
from ainovel_companion.config import APIConfig, AppConfig, RemoteConfig, SSHConfig
from ainovel_companion.db import PublishingDB


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
    assert client.get("/api/v1/books", headers={"X-Ainovel-Token": "secret"}).status_code == 200
