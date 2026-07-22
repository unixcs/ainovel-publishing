# Use a verified state machine for browser publication

**Status: accepted; recovery boundary amended by ADR 0012**

Publication is modeled as explicit, checkpointed states from plan approval through platform read-back verification. Each mutation must be followed by evidence of the resulting state; unknown dialogs, login/risk controls, quota errors, version conflicts, and ambiguous results become blocked rather than being swallowed, retried blindly, or counted as success. A chapter-list row proves that a schedule exists but does not prove the body version, so existing schedules reserve quota until editor content is matched. Only pre-mutation blocks may be explicitly reopened; ambiguous post-mutation states require reconciliation. Existing drafts, schedules, and published chapters are never silently duplicated or overwritten.
