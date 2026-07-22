# Installed Windows Host

Verified on **2026-07-22**.

## Host and paths

- OS: Windows 11 Pro 22H2
- Install root: `D:\Program\soft\code\demo\AinovelPublisher`
- Executable: `D:\Program\soft\code\demo\AinovelPublisher\ainovel-publisher.exe`
- Edge unpacked extension: `D:\Program\soft\code\demo\AinovelPublisher\extension`
- Edge profile: `Default`
- Local data/config: `%LOCALAPPDATA%\AinovelPublisher`
- Local API: `http://127.0.0.1:8787`

## Installed release

- Companion and extension version: `0.3.0`
- Publication timezone: `Asia/Shanghai`
- Daily safety cap: `9999`
- Allowed slots: `12:00`, `20:00`, `22:00`; default `20:00`
- Automatic execution: disabled until live selector acceptance succeeds
- SQLite publication-plan tables initialized without replacing the existing chapter ledger
- `tzdata` is bundled in the PyInstaller executable and plan creation was smoke-tested on Windows
- Packaged EXE SHA256: `4714732c0371d8842b7e1caa7a559dce0000e174f2793d2c8980abd4c4c7ec1e`
- Runtime health: `0.3.0`; SQLite integrity: `ok`; chapter ledger: `142` rows
- Existing API token, configuration, SSH paths, Chinese release paths and database were preserved
- Pre-upgrade backup: `D:\Program\soft\code\demo\AinovelPublisher\backups\20260722-215306-pre-0.3`

The two `ainovel-publisher.exe` process rows shown by Windows are the normal PyInstaller one-file parent/child pair for one service instance, not two independent assistants.

## Startup

The per-user Startup folder contains:

```text
%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\AinovelPublisherCompanion.vbs
```

It starts `serve --sync-first` hidden at Windows login. A failed initial synchronization is reported but no longer prevents the local API from starting.

## Edge rollout gate

The unpacked extension already points at the installed `extension` directory. After source replacement, restart the companion and use Edge's extension page to click **Reload**. Keep background automatic execution off for the first live run. Refresh the chapter list, then use the single “process chapter” action; existing rows are quota reservations and are not submitted again.

API tokens, the SQLite database, downloaded manuscripts, backups, and compiled executables are runtime-only and are not committed to Git.
