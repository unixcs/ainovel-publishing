# Publishing Plan Boundaries

Updated: 2026-07-22

## Confirmed scope

- One cloud server.
- One source novel: the configured source novel.
- One Fanqie work and account.
- One local computer and one Chrome profile.
- The server source chapters are the canonical manuscript.
- Daily transport will be incremental; the full ZIP remains a bootstrap, backup, and recovery path.
- The browser extension processes exactly one chapter per publishing attempt.
- After editor fill, automation stops. The user reviews and manually saves the draft or publishes.

## Existing Fanqie state before tracking begins

- Chapters 1–3: already published.
- Chapter 4: saved in the Fanqie draft box, not published.
- Chapter 5 onward: not yet classified by the new publishing workflow.

## Confirmed first-run reconciliation

- Chapters 1–3 are imported as `legacy_published` and are never automatically reprocessed.
- Chapter 4 is imported as `legacy_draft`.
- The extension compares the Fanqie draft title and body with the current server chapter before accepting it as `saved_draft`.
- A mismatch stops automation and shows a diff; the extension never overwrites the existing draft without an explicit user decision.

## Confirmed authority and recovery rules

- The server source chapter is authoritative for manuscript content and version hashes.
- Fanqie is authoritative for external draft and publication state.
- A durable server-side publishing ledger records the last platform state that was actually verified.
- Extension-local storage is a disposable cache and never the authoritative publishing record.
- Clicking a save or publish control does not prove success. A state transition is recorded only after the extension verifies the result from Fanqie.
- After a browser crash or ambiguous submission result, the next session reconciles with Fanqie before retrying.

## Confirmed version-change rules

- A chapter already saved as a Fanqie draft or published is never overwritten automatically.
- If its server content hash changes, the ledger records `changed_after_publish` or the corresponding draft conflict.
- The extension presents a content diff and requires an explicit user decision before entering a platform edit flow.
- New-chapter processing may continue, but unresolved version conflicts remain prominently visible.

## Confirmed stop policy

- Automation fails closed: every unknown page state or failed validation stops the current attempt.
- Stop conditions include expired login, identity verification, CAPTCHA, risk or declaration dialogs, unexpected work/chapter, missing editor controls, existing chapter-number conflicts, content/hash/count mismatch, lost server connection, ambiguous save/publish result, and unknown dialogs.
- On stop, the extension records the attempt, explains the reason, and waits for explicit user intervention. It never guesses, bypasses, retries a remote mutation, or advances to the next chapter.

## Confirmed workload boundary

- Phase one serves both the existing chapter 5 onward backlog and all future completed chapters.
- Backlog processing and ongoing processing use the same durable queue, chapter-version rules, checkpoints, and recovery behavior.
- Closing Chrome, restarting the computer, or losing the SSH connection must not lose the last verified position or cause a chapter to be repeated.

## Confirmed local architecture boundary

- A lightweight local companion application may be installed on the publishing computer.
- The companion owns SSH connectivity, incremental synchronization, local caching, reconnection, and the localhost API.
- The Chrome extension owns the queue UI, chapter preview, Fanqie editor interaction, and platform-result verification.
- WebDAV, Samba, and a public manuscript API are not required for phase one.

## Confirmed desktop boundary

- The first supported publishing computer is Windows 11 Pro 22H2.
- Packaging, startup integration, configuration paths, SSH-key handling, and troubleshooting are designed for that platform first.
- Other desktop operating systems are outside phase one.

## Grilling status

- The ten boundary questions are complete.
- No additional user decisions are required before phase-one implementation begins.

## Deferred beyond phase one

- Automatic draft saving remains out of phase one unless a later explicit decision changes the boundary.
