# ADR 0011: Simplified checkpoint-driven user flow

- Status: Accepted
- Date: 2026-07-22

## Context

The first live Edge trial exposed implementation states (`blocked`, raw reason codes and immutable plan snapshots) directly to the writer. A platform row that was already scheduled but whose body had not yet been compared appeared as a red failure. A chapter whose editor had already been filled could not continue through the same automated workflow. Fanqie's asynchronous editor mount also made the first fill click fail while a second click succeeded.

The safety model was correct about avoiding duplicate submissions, but the interface made the writer operate the internal state machine.

## Decision

The default interface has two operations:

1. **Refresh Fanqie status** from the chapter-management page.
2. **Process this chapter / process the next chapter** through the next valid checkpoint.

Advanced plan and single-step controls remain collapsed for diagnostics.

An existing platform row with a verifiable chapter number and publication date is now a `reserved` plan item. It reserves the full configured daily quota when its body version is unknown and is never submitted again. Body reconciliation remains available and recommended, but does not globally stop later chapters. A proven version conflict still blocks.

A locally `filled` chapter is planned with `resume_current_editor`. Automation may continue only from an open editor whose chapter number, title and full body match the immutable local version. It never opens another new chapter for this resume path.

The page adapter waits up to ten seconds for Fanqie's asynchronous editor mount and waits for controlled-input/ProseMirror state to settle after filling. Publication-list extraction accepts only one-chapter rows and recognizes review states, preventing a row under review from borrowing an adjacent row's `已发布` state or date.

The local source-work name and Fanqie display title are not assumed to be equal. A successful chapter-list refresh binds the local book to Fanqie's stable numeric work ID from the URL; subsequent new-chapter and resume actions verify that ID.

## Consequences

- Normal operation is one primary button instead of manual fill, plan approval and next-step clicks.
- Existing unverified platform chapters are shown as informational reservations, not red failures.
- Duplicate creation, content overwrite, CAPTCHA/risk bypass and unverified final submission remain fail-closed.
- A filled editor that is closed or changed cannot be recreated automatically; the writer is told to open the matching editor or reconcile the platform record.
