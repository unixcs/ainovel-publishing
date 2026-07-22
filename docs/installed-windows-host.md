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

- Companion/API and extension files: `0.3.2`
- Companion health: `0.3.2`; SQLite integrity: `ok`; chapter ledger: `142` rows
- Packaged EXE SHA256: `f87422133b4fbc7cd1a92b82e68bee8c8ac7ca516d1fa9d24ba96920f5105863`
- Windows-native companion tests: `37` passed; combined companion/extension suite: `62` passed
- Publication timezone: `Asia/Shanghai`
- Daily safety cap: `9999`
- Allowed slots: `12:00`, `20:00`, `22:00`; default `20:00`
- Background automatic execution remains disabled until one live `0.3.2` platform read-back succeeds
- Existing API token, configuration, SSH paths, Chinese release paths, database, and downloaded chapters were preserved
- Pre-upgrade backup: `D:\Program\soft\code\demo\AinovelPublisher\backups\20260722-233353-pre-0.3.2`

The two `ainovel-publisher.exe` process rows shown by Windows are the normal PyInstaller one-file parent/child pair for one service instance, not two independent assistants.

## Simplified browser path in 0.3.2

The primary action now has one deterministic route:

1. Resolve the Fanqie work ID. The current binding is `7664986207666850841`; other accounts/works get their own ID from the real Fanqie URL.
2. Use `book-manage` only for first-time binding. Once bound, open the canonical chapter-management URL directly.
3. Read the chapter list and save a ten-minute preflight for that work/tab.
4. Reuse that preflight to open exactly one new-chapter editor; do not repeat visible login/navigation checks.
5. Fill and verify chapter number, title, and body.
6. Click only the bottom-most visible, enabled, exact `button`/`role=button` named `下一步`. A containing `div` is never clicked.
7. Continue only through recognized typo/full-check/publish-settings states. Unknown transitions now record URL changes, editor presence/counts, visible buttons, dialogs, validation messages, and page text before stopping.
8. Persist `final_submit_armed` before the actual final scheduled-publish action. At or beyond that checkpoint, an unknown outcome is never blindly retried.

An old content script is detected by an adapter-version handshake. After the extension itself is reloaded, the first refresh/action reloads the Fanqie tab once automatically, so the user no longer has to refresh that tab manually.

## Chapter-8 safety state

The latest durable events remain:

```text
automation_started -> filled -> next_clicked -> blocked(post_next_state_unknown)
```

There is still no `final_submit_armed` and no `schedule_submitted`, so this is a recoverable pre-final-submit interruption. Chapter 8 intentionally remains `blocked` until version 0.3.2 performs a fresh chapter-management scan. When the user clicks `自动处理下一章`, the primary action will:

- scan the bound work first;
- stop without creating anything if chapter 8 exists on Fanqie;
- if chapter 8 is absent, use that fresh snapshot as the explicit user-authorized recovery evidence, supersede the stale plan, and continue the chapter once without a second confirmation prompt.

The database was not edited by hand and chapter 8 was not reset during deployment.

## Startup

The per-user Startup folder contains:

```text
%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\AinovelPublisherCompanion.vbs
```

It starts `serve --sync-first` hidden at Windows login. The currently running `0.3.2` service passed health, authenticated book-list, and SQLite checks after deployment.

## Remaining live acceptance action

1. Open `edge://extensions` and click **Reload** on **Ainovel 番茄发布助手**.
2. Open its side panel and confirm the companion reports `0.3.2` / 已连接.
3. Keep background automatic execution off and click `自动处理下一章` once.
4. Do not manually click Fanqie while the run is active. Success is accepted only after Fanqie chapter-list read-back confirms the intended date/time.

No manual Fanqie-tab refresh, old-plan approval, “解除阻塞”, token change, or SQLite edit is required. Runtime API tokens, SQLite data, manuscripts, backups, and compiled executables are not committed to Git.
