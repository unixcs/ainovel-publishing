# Ainovel Publisher Companion

Windows-first local companion for the Ainovel publishing workflow. It:

- connects to the Ainovel server over SSH/SFTP;
- incrementally downloads release manifests and chapter text;
- stores the publishing ledger in SQLite;
- exposes an authenticated API on `127.0.0.1:8787` for the browser extension;
- plans publication-day quota with a configurable safety cap and durable schedule evidence;
- distinguishes a visible platform schedule from a body-version-verified schedule.

## Development

```bash
python -m venv .venv
. .venv/bin/activate
pip install -e '.[dev]'
pytest
```

With `uv`:

```bash
uv sync --extra dev
uv run --extra dev pytest
```

## Commands

```bash
ainovel-publisher init
ainovel-publisher sync
ainovel-publisher serve --sync-first
ainovel-publisher print-token
```

## Configuration

`ainovel-publisher init` creates `%LOCALAPPDATA%\AinovelPublisher\config.json` on Windows. The generated server name and release path are examples; edit them before the first synchronization.

Before syncing, connect once from Windows with `ssh deploy@your-server.example.com` and verify the server fingerprint. This adds the verified host key to `%USERPROFILE%\.ssh\known_hosts`. The companion rejects unknown host keys instead of trusting them automatically.

The API token is generated locally. Do not commit `config.json`, the SQLite database, or a browser-extension directory containing a real token.

## Windows executable

From PowerShell:

```powershell
.\scripts\build-windows.ps1
```

The executable is written to `dist\ainovel-publisher.exe`. To install per-user automatic startup, run `scripts\install-autostart.ps1` with the executable path.
