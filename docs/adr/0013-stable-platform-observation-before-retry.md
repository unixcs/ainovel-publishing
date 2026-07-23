# Require a stable platform observation before absence can authorize retry

**Status: accepted**

Fanqie's chapter-management SPA mounts its shell, rows, and controls asynchronously, so an immediate empty DOM read is not evidence that a chapter is absent. The workflow accepts a platform absence observation only after the target list is actionable, contains positive data-readiness evidence (at least one real chapter row or an explicit empty-list state), and remains unchanged across a settling window; otherwise it stops without changing ledger state. A mounted toolbar and “新建章节” button alone are not list-readiness evidence. Reversible “新建章节” discovery may wait for a small exact control, while irreversible “下一步” and final submission keep stricter semantic selectors. An explicit no-click response remains pre-mutation and retryable, but a lost response after a possible click remains fail-closed.
