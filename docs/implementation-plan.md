# Phase One Implementation Plan

Updated: 2026-07-22

## Goal

Provide a Windows 11 Pro 22H2 publishing workstation that reliably processes both the existing chapter 5 onward backlog and future completed chapters, one chapter at a time, while keeping final save and publication under human control.

## Architecture

```text
ainovel source chapters
  -> server exporter and manifest
  -> Windows companion over SSH/SFTP
  -> local SQLite publishing ledger and chapter cache
  -> authenticated localhost API on 127.0.0.1:8787
  -> Chrome extension queue and preview
  -> one-chapter Fanqie editor fill
  -> human review and save/publish
  -> extension verifies platform result
  -> companion records verified event in the server-backed workflow
```

## Components

### Server exporter

- Existing source of normalized TXT artifacts and SHA256 manifest entries.
- Full batch ZIP remains for bootstrap, backup, and recovery.
- Incremental consumers compare chapter hashes and download only changed versions.

### Windows companion

- Owns SSH/SFTP connectivity and reconnection.
- Runs or requests a server export before synchronization.
- Stores chapters, versions, attempts, events, and last verified state in SQLite.
- Never treats extension-local storage as authoritative.
- Binds only to `127.0.0.1` and requires a local API token.

### Chrome extension

- Shows the backlog and future ready chapters from the companion.
- Previews exactly one selected chapter.
- Fills exactly one Fanqie editor page and then stops.
- Never saves, publishes, closes unknown dialogs, or advances automatically in phase one.
- Verifies page identity and filled content before reporting an event.

## Bootstrap

- Chapters 1–3 enter the ledger as `legacy_published`.
- Chapter 4 enters as `legacy_draft` and must be reconciled against the Fanqie draft.
- Chapters 5 onward enter the normal `ready` queue.

## Fail-closed rules

Unknown page state, authentication prompts, CAPTCHA, declaration/risk dialogs, wrong work/chapter, selector failures, existing chapter conflicts, content mismatch, connection loss, and ambiguous remote state all stop the attempt without retry or advancement.

## Delivery sequence

1. Companion database, synchronization, and localhost API.
2. Extension queue, preview, and health connection.
3. Fanqie page adapter and one-chapter fill validation.
4. First-run reconciliation for chapters 1–4.
5. Windows packaging, startup, logs, backup, and recovery documentation.
