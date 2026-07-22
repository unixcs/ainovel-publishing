# Recover pre-submit interruptions at the final-submit boundary

**Status: accepted**

Fanqie's “Next” action is not publication: it may expose typo checks, full inspection, and publication settings without sending the final schedule. Treating any editor mutation as irreversible created a permanent queue deadlock after chapter 8 reached “Next” but never submitted. The workflow now uses the final scheduled-publish action as the irreversible boundary. A stopped run before that boundary may return to `ready` only after a fresh target-work chapter-list scan shows the chapter absent and the user confirms it was not submitted; an armed or attempted final submission remains fail-closed and requires reconciliation. Preparing publication settings and issuing final submission are separate browser actions, with a durable `final_submit_armed` checkpoint written before the latter is sent.

Only one publication plan may remain approved for a work. Creating a proposal supersedes older drafts, approving it supersedes older approved plans, and recovery supersedes every active snapshot before recalculation. Chapter versions and platform observations remain authoritative, so stale plans cannot race the recovered chapter or skip ahead in the queue.
