from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import uvicorn

from .api import create_app
from .config import default_config_path, initialize_config, load_config
from .db import PublishingDB
from .sync import RemoteSynchronizer, SyncError


def parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="ainovel-publisher")
    p.add_argument("--config", type=Path, default=None, help="Path to config.json")
    sub = p.add_subparsers(dest="command", required=True)
    init = sub.add_parser("init", help="Create the Windows companion configuration")
    init.add_argument("--overwrite", action="store_true")
    sync = sub.add_parser("sync", help="Run remote export and incrementally synchronize chapters")
    sync.add_argument("--skip-export", action="store_true")
    serve = sub.add_parser("serve", help="Run the authenticated localhost API")
    serve.add_argument("--sync-first", action="store_true")
    sub.add_parser("print-token", help="Print the local API token for extension setup")
    return p


def main(argv: list[str] | None = None) -> int:
    args = parser().parse_args(argv)
    config_path = args.config or default_config_path()
    if args.command == "init":
        target = initialize_config(config_path, overwrite=args.overwrite)
        config = load_config(target)
        config.data_dir.mkdir(parents=True, exist_ok=True)
        PublishingDB(config.database_path)
        print(json.dumps({"config": str(target), "database": str(config.database_path), "api_token": config.api.token}, ensure_ascii=False, indent=2))
        return 0

    config = load_config(config_path)
    config.data_dir.mkdir(parents=True, exist_ok=True)
    db = PublishingDB(config.database_path)
    synchronizer = RemoteSynchronizer(config, db)

    if args.command == "sync":
        try:
            result = synchronizer.sync(run_export=not args.skip_export)
        except SyncError as exc:
            print(str(exc), file=sys.stderr)
            return 2
        print(json.dumps(result.to_dict(), ensure_ascii=False, indent=2))
        return 0

    if args.command == "print-token":
        print(config.api.token)
        return 0

    if args.command == "serve":
        if args.sync_first:
            try:
                print(json.dumps(synchronizer.sync(run_export=True).to_dict(), ensure_ascii=False, indent=2))
            except SyncError as exc:
                print(f"Initial sync failed; API will still start: {exc}", file=sys.stderr)
        app = create_app(config, db, synchronizer)
        uvicorn.run(app, host=config.api.host, port=config.api.port, log_level="info")
        return 0

    return 1


if __name__ == "__main__":
    raise SystemExit(main())
