# Ainovel Publishing

A local-first publishing pipeline that moves completed Ainovel chapters from a server into the Fanqie Writer editor and can create quota-aware future publications without moving the logged-in browser session to the cloud.

## First-principles design

The system separates four responsibilities because they have different trust and failure boundaries:

1. **Server exporter** — turns canonical completed Markdown chapters into deterministic release artifacts and a SHA256 manifest.
2. **Windows companion** — owns SSH/SFTP access, local chapter cache, SQLite publishing ledger, quota-aware publication plans, and the authenticated localhost API.
3. **Browser extension** — owns the local logged-in Edge session, page/state recognition, editor interaction, publication settings, and read-back verification.
4. **Human operator** — starts the single primary action, handles login/CAPTCHA/risk-control or unknown states, and resolves real version conflicts. Planning and approval are internal workflow steps rather than separate UI buttons.

```text
Ainovel source chapters
  -> server/export_fanqie.py
  -> manifest + chapter artifacts
  -> SSH/SFTP
  -> Windows companion + SQLite ledger + quota planner
  -> authenticated 127.0.0.1 API
  -> Edge extension state machine
  -> Fanqie editor and publication settings
  -> scheduled/public platform state
  -> read-back verification
```

## Current status

Version `0.3.4` keeps the one-action daily path and closes the editor-hydration race found in the first 0.3.3 live run. It first obtains the same stable chapter-list evidence, then waits for Fanqie to replace its temporary blank new-chapter shell with a persistent draft ID and stable field nodes before writing. The complete chapter must remain unchanged for 2.5 seconds; one verified-empty remount of the same draft may be refilled once. The exact “下一步” action may be a small custom ByteDance control, so the adapter accepts only the enabled top editor action and rejects lower tutorials/dialogs. Final-submit, version, quota, reconciliation, and read-back boundaries remain fail-closed; background automatic execution stays **off** until a live platform read-back succeeds. The companion rejects every authenticated request from a missing or mismatched extension version, so the already-loaded 0.3.3 worker cannot operate after the 0.3.4 update. See [`docs/implementation-plan.md`](docs/implementation-plan.md) and [`extension/README.md`](extension/README.md).

## Repository layout

- `server/` — exporter deployed beside the Ainovel server workspace.
- `companion/` — Python Windows companion, ledger, planner boundary, and tests.
- `extension/` — Manifest V3 Edge/Chrome extension and page adapter.
- `scripts/` — optional manual release-download helper.
- `docs/adr/` — accepted architecture decisions.
- `docs/research/` — external project and reuse reviews.
- `.github/workflows/` — Windows test and executable build workflow.

Runtime data, manuscripts, downloaded releases, API tokens, databases, virtual environments, and compiled executables are intentionally excluded from Git.

## Quick start

### 1. Deploy the exporter

```bash
scp server/export_fanqie.py deploy@your-server.example.com:/opt/ainovel/export_fanqie.py
ssh deploy@your-server.example.com 'python3 /opt/ainovel/export_fanqie.py'
```

The default paths can be overridden with `AINOVEL_SOURCE_ROOT` and `AINOVEL_EXPORT_ROOT`.

### 2. Configure the Windows companion

See [`companion/README.md`](companion/README.md). Initialize it, edit the generated server/release settings, synchronize, and start the localhost service.

### 3. Load the extension

See [`extension/README.md`](extension/README.md). Load `extension/` as an unpacked extension in Edge or Chrome, enter the localhost API token, log in to Fanqie, and click **检查并处理下一章**. No separate refresh, plan update, approval, or execution step is required.

## Safety boundaries

- One server, one workstation, one account, one work, and one chapter version per automation run.
- Existing title/body content, drafts, schedules, and published chapters are never silently overwritten or duplicated.
- Publication plans cannot exceed the configured safety cap (currently 9,999 units) and offer selectable 12:00/20:00/22:00 Asia/Shanghai slots.
- A chapter-list row reserves quota and is skipped without duplicate submission; it is not claimed as the current source version until title/body reconciliation succeeds.
- Source-version conflicts, quota ambiguity, unknown page states, login expiry, CAPTCHA, and risk-control prompts stop the run.
- A click is never recorded as success until Fanqie read-back verifies the intended chapter and schedule/publication state.
- “Next” is recoverable after platform absence verification; once final submission is armed, a missing result is never blindly retried.
- Exactly one approved plan can drive a work, so stale plan snapshots cannot race later chapters.
- Credentials and browser login state remain local; the server never operates the Fanqie browser session.
- The full ZIP is only a bootstrap, backup, and recovery channel; normal synchronization is incremental.

## Development checks

```bash
uv run --project companion --extra dev pytest companion/tests extension/tests
node --check extension/background.js
node --check extension/content-script.js
node --check extension/sidepanel.js
```
