# Ainovel Publishing

A human-controlled publishing pipeline that moves completed Ainovel chapters from a server into the Fanqie Writer editor without automatically saving or publishing them.

## First-principles design

The system separates four responsibilities because they have different trust and failure boundaries:

1. **Server exporter** — turns canonical completed Markdown chapters into deterministic release artifacts and a SHA256 manifest.
2. **Windows companion** — owns SSH/SFTP access, local chapter cache, SQLite publishing ledger, and the authenticated localhost API.
3. **Browser extension** — previews a single queued chapter and fills the current Fanqie editor only after conflict checks.
4. **Human operator** — reviews the result and remains the only actor allowed to save a draft or publish.

This avoids exposing manuscript files through a public WebDAV/API endpoint, avoids giving a browser extension SSH credentials, and fails closed when the page state is unknown.

```text
Ainovel source chapters
  -> server/export_fanqie.py
  -> manifest + chapter artifacts
  -> SSH/SFTP
  -> Windows companion + SQLite ledger
  -> authenticated 127.0.0.1 API
  -> Edge/Chrome extension
  -> one-chapter editor fill
  -> human review and save/publish
```

## Repository layout

- `server/` — exporter deployed beside the Ainovel server workspace.
- `companion/` — Python Windows companion and tests.
- `extension/` — Manifest V3 Edge/Chrome extension and tests.
- `scripts/` — optional manual release-download helper.
- `docs/adr/` — accepted architecture decisions.
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

See [`extension/README.md`](extension/README.md). Load `extension/` as an unpacked extension in Edge or Chrome, enter the localhost API token, open a Fanqie chapter editor, and fill one chapter at a time.

## Safety boundaries

- One server, one workstation, one account, and one selected chapter at a time.
- Existing title/body content is never silently overwritten.
- Source-version conflicts stop the workflow for manual review.
- Unknown page states stop the workflow.
- The extension never automatically saves, publishes, dismisses dialogs, or advances to another chapter.
- The full ZIP is only a bootstrap, backup, and recovery channel; normal synchronization is incremental.

## Development checks

```bash
uv run --project companion --extra dev pytest companion/tests extension/tests
node --check extension/background.js
node --check extension/content-script.js
node --check extension/sidepanel.js
```
