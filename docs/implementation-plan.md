# Automated Publication Implementation Plan

Updated: 2026-07-22. Core implementation and fixture tests are complete; Windows deployment and real Fanqie DOM validation remain staged with automatic execution disabled.

## Target architecture

```text
Ainovel source + progress
  -> server exporter + manifest
  -> SSH/SFTP
  -> Windows companion + SQLite ledger
  -> quota planner + publication plan
  -> authenticated localhost API
  -> Edge extension automation state machine
  -> Fanqie editor and publication settings
  -> scheduled/public platform state
  -> read-back verification + ledger event
```

### Ownership

**Server exporter** owns deterministic chapter normalization, hashes, and release artifacts. It does not hold Fanqie credentials or operate a browser.

**Windows companion** owns synchronization, the durable ledger, quota configuration, publication plans, reconciliation records, retry-safe checkpoints, and local notifications/API.

**Edge extension** owns login/work/page recognition, navigation, editor interaction, dialog handling, publication settings, and platform read-back verification. It never treats a click as proof of success.

**User** owns credentials, CAPTCHA/risk-control intervention, policy overrides, and resolving version conflicts. A single “start this approved plan” action enables automated execution; no hidden mutation occurs outside the plan.

## State machine

The browser runner must implement explicit states rather than a sequence of blind clicks:

```text
plan_created
  -> plan_approved
  -> login_verified
  -> work_verified
  -> chapter_target_verified
  -> editor_ready
  -> fields_filled
  -> fields_verified
  -> next_step_verified
  -> typo_prompt_confirmed (optional)
  -> full_check_started
  -> full_check_completed
  -> publish_settings_verified
  -> awaiting_ai_choice (optional manual policy)
  -> ai_policy_verified
  -> schedule_submitted
  -> schedule_verified
```

Every state has a timeout, evidence snapshot, and terminal `blocked` outcome. A chapter-list schedule observation and a chapter-version verification are separate evidence. A browser restart resumes from reconciliation, never from an assumed middle click.

## Delivery phases

### Phase 1 — Domain and persistence

- Add quota policy, schedule-slot, AI policy, publication-plan, run, and platform-observation models.
- Extend SQLite events/statuses without losing the existing chapter ledger.
- Store plan version, source hash, quota date, slot, AI choice, and verification evidence.
- Add a dry-run planner that produces a human-readable schedule before any browser mutation.

### Phase 2 — Quota planner

- Normalize chapter text using the same count basis as the release artifact.
- Calculate publication-day usage from verified platform schedules/publications plus the local ledger.
- Enforce `9999` as the initial effective limit.
- Offer slots at 12:00, 20:00, and 22:00, defaulting to 20:00.
- Detect chapters that exceed a day and block them rather than splitting them.
- Recompute the remaining plan after every verified platform observation.

### Phase 3 — Platform reconciliation

- Read the writer center, current work, chapter list, drafts, and scheduled entries.
- Match by work identity, chapter number, and available version/content evidence.
- Adopt matching existing schedules; flag mismatches and duplicates.
- Never cancel or overwrite an existing schedule automatically.

### Phase 4 — Browser state machine

- Replace broad text/coordinate clicks with scoped, semantic, visible, enabled controls.
- Verify each transition by its resulting page/dialog state.
- Handle the known typo confirmation and full-check loading states explicitly.
- Treat risk prompts, CAPTCHA, login pages, unknown dialogs, and missing selectors as `blocked`.
- Keep the runner local to the logged-in Edge profile.

### Phase 5 — Scheduling and verification

- Navigate to the writer center and create a chapter only after target reconciliation.
- Fill and validate chapter number, title, body, normalized count, and source hash.
- Advance through the known publication flow.
- Apply the configured AI policy and selected publication slot.
- Submit once, then verify the chapter appears with the intended schedule/version.
- Record success only after verification; otherwise preserve the attempt as ambiguous/blocked.

### Phase 6 — Staged rollout

1. **Done:** planner-only mode and fixture-tested state machine.
2. **Done:** fill-only behavior retained; automation defaults to off.
3. **Next:** install version 0.2.0 and read the existing fourth/fifth schedule rows.
4. **Next:** open those scheduled chapters and match chapter number, title, and body before adoption.
5. **Next:** run one non-critical future chapter with automation still manually triggered.
6. **Then:** enable automatic execution for later approved plan items.
7. **Later:** add richer post-mutation recovery, notifications, and audit views after the first verified live runs.

## Tests and acceptance criteria

- Unit tests for quota arithmetic, date/slot assignment, existing-schedule adoption, duplicate prevention, version conflicts, and over-limit chapters.
- Browser tests with fixture pages for login, editor, typo prompt, full-check loading, AI choice, publish settings, success, unknown dialog, and quota rejection.
- End-to-end test that kills/restarts the browser after each state and proves reconciliation prevents duplicate submission.
- A real run is successful only when Fanqie read-back confirms the intended chapter version and future slot.

Current automated suite: 43 unit/browser tests. The restart fault-injection test and real Fanqie acceptance run remain rollout gates, not assumed successes.
