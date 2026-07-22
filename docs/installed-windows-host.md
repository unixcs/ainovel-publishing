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

- Companion and extension version: `0.2.0`
- Publication timezone: `Asia/Shanghai`
- Daily safety cap: `9999`
- Allowed slots: `12:00`, `20:00`, `22:00`; default `20:00`
- Automatic execution: disabled until live selector acceptance succeeds
- SQLite publication-plan tables initialized without replacing the existing chapter ledger
- `tzdata` is bundled in the PyInstaller executable and plan creation was smoke-tested on Windows

The two `ainovel-publisher.exe` process rows shown by Windows are the normal PyInstaller one-file parent/child pair for one service instance, not two independent assistants.

## Startup

The per-user Startup folder contains:

```text
%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\AinovelPublisherCompanion.vbs
```

It starts `serve --sync-first` hidden at Windows login. A failed initial synchronization is reported but no longer prevents the local API from starting.

## Edge rollout gate

The unpacked extension already points at the installed `extension` directory. After source replacement, use Edge's extension page to click **Reload**. Keep automatic execution off, reconcile the existing chapter 4/5 schedules and bodies, then manually trigger one future chapter before enabling the alarm-driven runner.

API tokens, the SQLite database, downloaded manuscripts, backups, and compiled executables are runtime-only and are not committed to Git.
