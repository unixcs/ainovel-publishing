# Installed Windows Host

Verified on **2026-07-23**.

## Host and paths

- OS: Windows 11 Pro 22H2
- Install root: `D:\Program\soft\code\demo\AinovelPublisher`
- Executable: `D:\Program\soft\code\demo\AinovelPublisher\ainovel-publisher.exe`
- Edge unpacked extension: `D:\Program\soft\code\demo\AinovelPublisher\extension`
- Edge profile: `Default`
- Local data/config: `%LOCALAPPDATA%\AinovelPublisher`
- Local API: `http://127.0.0.1:8787`

## Installed release

- Companion/API and extension files on disk: `0.3.3`
- Companion health: `0.3.3`; required browser client: `0.3.3`
- SQLite integrity: `ok`; chapter ledger: `164` rows; event ledger: `281` rows
- The pre-upgrade 142 rows and their hashes were preserved; the normal startup synchronization added server chapters 143–164 without deleting or replacing an older chapter hash
- Packaged EXE SHA256: `d77752f62e575296da0bf5bb5c0488b9c2de06efdda51c03078194a259354814`
- Windows-native companion tests: `37` passed; combined companion/extension suite: `76` passed
- Publication timezone: `Asia/Shanghai`
- Daily safety cap: `9999`
- Allowed slots: `12:00`, `20:00`, `22:00`; default `20:00`
- Existing API token, configuration, SSH paths, Chinese release paths, database, and downloaded chapters were preserved
- Backup: `D:\Program\soft\code\demo\AinovelPublisher\backups\20260723-123537-pre-0.3.3`
  - original `0.3.2` EXE and extension;
  - integrity-checked 142-row pre-upgrade database;
  - integrity-checked 164-row post-sync/pre-fence database;
  - unchanged `config.json`.

Windows normally shows two `ainovel-publisher.exe` rows because PyInstaller one-file mode uses a parent/child pair for one service.

## 0.3.3 normal browser path

The ordinary UI now has one primary action: **检查并处理下一章**.

1. Open the bound work's canonical chapter-management URL.
2. Wait until the SPA has stopped loading, a usable “新建章节” control exists, at least one real chapter row (or an explicit empty-list state) proves the list data arrived, and the whole visible list remains unchanged across the settling window.
3. Use only that stable snapshot for existing-row reconciliation or platform-absence recovery. A header/button-only or otherwise half-loaded page is never accepted as “all chapters absent”.
4. Internally create and approve a fresh quota-aware plan. Manual “更新排程 / 批准排程 / 执行下一章” buttons no longer exist.
5. Wait for the reversible “新建章节” control and click one exact small control. Missing controls return `mutationAttempted:false`, so no-click failures remain retryable instead of becoming `blocked`.
6. Fill and verify chapter number, title, and body.
7. Keep the existing strict exact real-button selection for `下一步`, then run known typo/full-check/publish-setting steps.
8. Persist `final_submit_armed` before the actual final scheduled-publish action. Any ambiguity at or after this point remains reconciliation-only.
9. Read back the stable chapter list and accept success only when the target date/time matches.

The short-lived platform preflight is consumed by the immediately following mutation. Background/direct runs that do not have a side-panel preflight perform their own stable list read before creating a chapter.

## Stale-extension fence found during rollout

While replacing the files, Edge still had the old `0.3.2` service worker in memory. It ran once against the newly synchronized ledger and reproduced the old no-button bug on chapter 13. Version `0.3.3` therefore adds an exact client-version header and companion-side gate on every authenticated API read:

- a token-only or `0.3.2` request receives HTTP `409 stale_extension_version`;
- a `0.3.3` request receives HTTP `200`;
- the old service worker cannot fetch books/plans/chapters, so it cannot reach a page mutation before the user reloads the unpacked extension;
- after reload, the `0.3.3` safety epoch forces background automatic execution off.

The live fence was verified with both HTTP outcomes. This is intentionally stricter than a rolling upgrade because browser automation must never mix a new ledger with stale selectors.

## Current recovery boundary

No chapter was reset by editing SQLite. The current safe states are:

- Chapter 8: `blocked`, recoverable, last verified checkpoint `next_clicked`, no final submission checkpoint.
- Chapter 9: `blocked`, recoverable, last verified checkpoint `preflight`.
- Chapter 13: `blocked`, recoverable, last verified checkpoint `preflight`; this is the single stale-0.3.2 rollout incident described above.

All three require one fresh stable target-work scan. If a row exists on Fanqie, the extension stops and reconciles it. If absent, the same primary action clears the recoverable false blocks through the formal recovery API and **preserves the original next target**, so it returns to chapter 8 instead of skipping to chapter 9 or 13.

## Startup

The per-user Startup folder contains:

```text
%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\AinovelPublisherCompanion.vbs
```

It starts `serve --sync-first` hidden at Windows login. During this rollout the latest server sync completed first, then the final fenced `0.3.3` service was started without a second redundant export.

## One remaining live browser action

1. Open `edge://extensions` and click **重新加载** on **Ainovel 番茄发布助手**.
2. Reopen the side panel. It must show **已连接** and no “插件版本未生效” warning.
3. Keep background automatic execution off and click **检查并处理下一章** once.
4. Do not manually click Fanqie while the run is active.

No manual Fanqie-tab refresh, plan update/approval/execution, unblock button, token change, or SQLite edit is required. Runtime API tokens, SQLite data, manuscripts, backups, and compiled executables are not committed to Git.
