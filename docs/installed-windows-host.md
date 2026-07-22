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

- Companion and extension files: `0.3.1`
- Companion health: `0.3.1`; SQLite integrity: `ok`; chapter ledger: `142` rows
- Packaged EXE SHA256: `1e4e08b97183f0e88016c41d0baf1f15628cc4690946db69d6486c498a7c7aad`
- Windows-native companion tests: `37` passed; combined companion/extension suite: `56` passed
- Publication timezone: `Asia/Shanghai`
- Daily safety cap: `9999`
- Allowed slots: `12:00`, `20:00`, `22:00`; default `20:00`
- Automatic execution remains disabled until one live `0.3.1` platform read-back succeeds
- Existing API token, configuration, SSH paths, Chinese release paths, database, and downloaded chapters were preserved
- Pre-upgrade backup: `D:\Program\soft\code\demo\AinovelPublisher\backups\20260722-225030-pre-0.3.1`

The two `ainovel-publisher.exe` process rows shown by Windows are the normal PyInstaller one-file parent/child pair for one service instance, not two independent assistants.

## Chapter-8 recovery applied

The ledger proved that chapter 8 reached `next_clicked` but never reached `final_submit_armed` or `schedule_submitted`. The user also confirmed that a fresh Fanqie chapter-management scan had no chapter-8 row. The authenticated `recover-unsubmitted` API therefore recorded the platform absence and recovery events, changed chapter 8 from `blocked` to `ready`, cleared its old error, and superseded all 38 stale draft/approved plan snapshots. The database was not edited by hand.

The new boundary is:

- editor fill, “Next”, typo confirmation, and full inspection are pre-submit and recoverable after a live absence check;
- `final_submit_armed` is written before the final scheduled-publish action is sent;
- at or beyond that checkpoint, an unknown result stays fail-closed and cannot be recreated blindly;
- only one approved publication plan can drive a work.

## Startup

The per-user Startup folder contains:

```text
%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\AinovelPublisherCompanion.vbs
```

It starts `serve --sync-first` hidden at Windows login. A failed initial synchronization is reported but no longer prevents the local API from starting.

## Edge rollout gate

The unpacked extension directory now contains `0.3.1`, but an already-open Edge extension/service worker and Fanqie tab keep the old scripts until reloaded. The remaining user actions are:

1. Open `edge://extensions`, click **Reload** on Ainovel 番茄发布助手.
2. Refresh the existing Fanqie chapter-management tab once.
3. Confirm the side panel reports companion `0.3.1`.
4. Keep background automatic execution off and click `自动处理下一章` once.

Chapter 8 is already `ready`; no manual “解除阻塞”, SQLite edit, or old-plan approval is needed. API tokens, SQLite data, manuscripts, backups, and compiled executables remain runtime-only and are not committed to Git.
