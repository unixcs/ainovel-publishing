# Windows 11 Pro 22H2 Setup

## Build or obtain the executable

The Windows executable is produced by `companion/scripts/build-windows.ps1`. A GitHub Actions workflow is also provided at `.github/workflows/build-windows.yml` and uploads `ainovel-publisher.exe` as a build artifact.

## Prepare SSH trust

Open PowerShell and connect once using Windows OpenSSH:

```powershell
ssh deploy@your-server.example.com
```

Verify the displayed server fingerprint through a trusted channel before accepting it. The companion rejects unknown host keys and uses `%USERPROFILE%\.ssh\known_hosts`.

The default configuration expects the private key at:

```text
%USERPROFILE%\.ssh\id_ed25519
```

## Initialize

```powershell
.\ainovel-publisher.exe init
```

Configuration and SQLite data are stored under:

```text
%LOCALAPPDATA%\AinovelPublisher
```

## Test synchronization

```powershell
.\ainovel-publisher.exe sync
```

The first sync imports the current manifest. Chapters 1–3 become `legacy_published`, chapter 4 becomes `legacy_draft`, and chapter 5 onward enters `ready`.

## Start the localhost API

```powershell
.\ainovel-publisher.exe serve --sync-first
```

It binds only to:

```text
http://127.0.0.1:8787
```

Get the extension token:

```powershell
.\ainovel-publisher.exe print-token
```

## Start automatically at Windows login

From the unpacked companion folder:

```powershell
Set-ExecutionPolicy -Scope Process Bypass
.\scripts\install-autostart.ps1 -Executable .\dist\ainovel-publisher.exe
```

Remove automatic startup with:

```powershell
.\scripts\uninstall-autostart.ps1
```

## Load the Chrome extension

1. Open `chrome://extensions`.
2. Enable Developer mode.
3. Choose “Load unpacked”.
4. Select the `extension` directory.
5. Open the side panel and enter the token from `print-token`.
6. Test connection, then synchronize the server queue.

## First operation

1. Open chapter 4 from the Fanqie draft box.
2. Select chapter 4 in the extension under `legacy_draft`.
3. Run draft reconciliation. It reads and compares but does not overwrite.
4. Resolve any mismatch manually.
5. Continue with chapter 5, one chapter per attempt.
