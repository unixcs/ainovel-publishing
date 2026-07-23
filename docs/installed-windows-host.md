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

- Companion/API and extension files on disk: `0.3.4`
- Companion health / required browser client: `0.3.4` / `0.3.4`
- SQLite integrity: `ok`; chapter ledger: `164` rows; event ledger: `328` rows
- The original 142 rows and their hashes remain preserved; the prior normal synchronization added server chapters 143–164 without deleting or replacing an older chapter hash
- Packaged EXE SHA256: `952fa4bf02eab6fd82b8129c9f4ec6248d827ef67137d99be62f0ccefb748784`
- Windows-native companion tests: `37` passed; combined companion/extension suite: `80` passed
- Publication timezone: `Asia/Shanghai`; daily safety cap: `9999`
- Allowed slots: `12:00`, `20:00`, `22:00`; default `20:00`
- Existing API token, configuration, SSH paths, Chinese release paths, database, and downloaded chapters were preserved byte-for-byte where applicable
- Current backup: `D:\Program\soft\code\demo\AinovelPublisher\backups\20260723-170155-pre-0.3.4`
  - installed `0.3.3` EXE and extension;
  - unchanged `config.json`;
  - integrity-checked database with 164 chapters and 328 events.
- Earlier pre-0.3.3 backup remains at `D:\Program\soft\code\demo\AinovelPublisher\backups\20260723-123537-pre-0.3.3`.

Windows normally shows two `ainovel-publisher.exe` rows because PyInstaller one-file mode uses a parent/child pair for one service.

## 0.3.4 normal browser path

The ordinary UI still has one primary action: **检查并处理下一章**.

1. Open the bound work's canonical chapter-management URL and obtain the existing 0.3.3 stable positive-data list observation.
2. Reconcile platform rows, recover only a pre-final-submit absence, and internally create/approve a fresh quota-aware plan.
3. Click one exact small “新建章节” control.
4. Do **not** write to the first blank editor shell. Wait for Fanqie to assign `/publish/<draft-id>`, keep the same title/number/body nodes stable for one second, and observe the top editor action.
5. Fill chapter number, title, and body. The complete chapter must remain unchanged for 2.5 seconds. If the same draft replaces it with one verified-empty editor tree, refill exactly once and verify again; any non-empty difference stops.
6. Wait up to 15 seconds for an exact, enabled, small top-bar “下一步” semantic or custom ByteDance control. Lower tutorials/dialogs and large containers never qualify. Revalidate all chapter fields immediately before clicking.
7. Run the known typo/full-check/publish-setting flow. Persist `final_submit_armed` before the final scheduled-publish action and remain reconciliation-only after any ambiguity at that boundary.
8. Read back a stable list and accept success only when the target platform date/time matches.

The short-lived list preflight is target-aware and consumed by the immediately following mutation. Background/direct runs without a side-panel preflight perform their own stable list read.

## Live evidence behind 0.3.4

Four 0.3.3 chapter-8 attempts ended with `next_button_missing`. Each failure record proved:

- the editor still contained the expected title, chapter number, and all `4544` body characters at the checkpoint;
- `final_submit_armed` was false;
- the tab had changed from the temporary `/publish/` URL to persistent draft `7665357226344710718`;
- visible page text started with “下一步”, but no semantic `button`/`role=button` candidate existed.

This rules out missing source content. The real defects were writing before Fanqie's persistent draft remount and assuming the top “下一步” was always a semantic button. The regression suite now covers delayed draft-ID assignment, editor remount, one safe same-draft refill, custom top actions, delayed enablement, and rejection of lower tutorials/plain containers.

## Exact browser-version fence

Every authenticated localhost API request carries the extension version. Live 0.3.4 verification produced:

- token-only request: HTTP `409`;
- `0.3.3` client: HTTP `409`;
- `0.3.4` client: HTTP `200`.

Thus the already-loaded 0.3.3 Edge worker cannot read a plan or mutate Fanqie after this upgrade. Reloading the unpacked extension is mandatory, and the 0.3.4 safety epoch turns background automatic execution off.

## Current recovery boundary

No SQLite row was reset manually.

- Chapter 8: `blocked`, recoverable, last verified checkpoint `filled`, last error `next_button_missing`, and no final-submission checkpoint.
- Chapters 9 and 13: already recovered through the formal absence/recovery API and currently `ready`.

The next primary action performs one new stable list scan. If Fanqie contains chapter 8, it stops and reconciles rather than creating a duplicate. If absent, it formally recovers chapter 8 and runs the 0.3.4 persistent-editor path.

## Startup

The per-user Startup folder contains:

```text
%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\AinovelPublisherCompanion.vbs
```

It starts `serve --sync-first` hidden at Windows login. The current 0.3.4 service was started with `serve` after the already-current database was backed up; no redundant server export was run during this repair.

## One remaining live browser action

1. Open `edge://extensions` and click **重新加载** on **Ainovel 番茄发布助手**.
2. Reopen the side panel. It must show **已连接** and no stale-version warning.
3. Keep background automatic execution off and click **检查并处理下一章** once.
4. Do not manually click or refresh Fanqie while the run is active.

No manual platform refresh, plan update/approval/execution, unblock button, token change, or SQLite edit is required. Runtime API tokens, SQLite data, manuscripts, backups, and compiled executables are not committed to Git.
