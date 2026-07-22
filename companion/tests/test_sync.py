from pathlib import Path

import pytest

from ainovel_companion.config import APIConfig, AppConfig, RemoteConfig, SSHConfig
from ainovel_companion.db import PublishingDB
from ainovel_companion.sync import RemoteSynchronizer, SyncError


class MissingManifestSFTP:
    def open(self, _path: str, _mode: str):
        raise FileNotFoundError("manifest missing")

    def close(self) -> None:
        pass


class FakeSSH:
    def open_sftp(self) -> MissingManifestSFTP:
        return MissingManifestSFTP()

    def close(self) -> None:
        pass


def test_missing_remote_manifest_is_reported_as_sync_error(tmp_path: Path):
    config = AppConfig(
        config_path=tmp_path / "config.json",
        data_dir=tmp_path,
        database_path=tmp_path / "publisher.db",
        ssh=SSHConfig("example", 22, "admin", None, None, 10),
        remote=RemoteConfig("true", "/missing/manifest.jsonl", "/missing/release"),
        api=APIConfig("127.0.0.1", 8787, "secret"),
    )
    synchronizer = RemoteSynchronizer(config, PublishingDB(config.database_path))
    synchronizer._connect = lambda: FakeSSH()  # type: ignore[method-assign]

    with pytest.raises(SyncError, match="Remote synchronization failed: manifest missing"):
        synchronizer.sync(run_export=False)
