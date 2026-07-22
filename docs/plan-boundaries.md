# Automated Publication Plan Boundaries

Updated: 2026-07-22. This document records the boundaries confirmed during the grill-with-docs session before implementation.

## Confirmed scope

- One cloud source server, one Fanqie work, one Fanqie account, and one Windows 11 workstation with Edge.
- The canonical manuscript remains on the Ainovel server; the local companion remains the transport and ledger boundary.
- The extension may automatically complete the known Fanqie publication flow, including final submission and future scheduling.
- The browser must use the user's existing logged-in Edge profile. Credentials, OTPs, CAPTCHA solving, and risk-control bypasses are out of scope.
- The first release remains one chapter version per automation run. The planner may produce a multi-day plan, but execution is checkpointed chapter by chapter.

## Quota and schedule policy

- The user's current quota policy is modeled as a **publication-day** limit.
- Initial effective daily limit: **9,999 quota units**. The UI must show the count used, remaining capacity, and the source of each count.
- The planner must not split one source chapter into multiple platform chapters automatically. A chapter over the effective limit is blocked for explicit handling.
- Publication slots are configurable choices, not constants: `12:00`, `20:00`, and `22:00` in `Asia/Shanghai`; the default is `20:00`.
- A future platform schedule is distinct from the local time when the browser submits it. The planner chooses the publication slot; the runner submits as soon as the browser is available and the plan is still valid.
- A visible Fanqie schedule reserves capacity immediately, but it is adopted only after the editor title/body confirms the current chapter version.
- The current fourth- and fifth-chapter schedules are reconciled and adopted if their chapter versions match; they are never submitted again.

## AI declaration policy

- The default policy is per-work and remembers the last explicitly confirmed choice.
- The user can choose “use AI”, “do not use AI”, remember the last explicit per-work choice, or pause at each chapter for a manual choice.
- If the setting is missing, ambiguous, or changed by the platform, automation stops rather than guessing.

## Platform state and safety

- Before every mutation, verify login identity, work identity, chapter number, chapter version, editor fields, and the expected page state.
- After every mutation, read the platform state back before recording success.
- Existing drafts, schedules, and published chapters are never silently overwritten or duplicated.
- Unknown dialogs, CAPTCHA, risk-control prompts, login expiry, quota rejection, missing controls, content mismatch, network loss, and ambiguous submission results enter `blocked` and wait for human intervention.
- A failed or ambiguous click is never counted as a successful publication, and a local file is never archived merely because a button was clicked.
- Only failures proven to occur before any editor/platform mutation can be reopened directly. Later failures require platform reconciliation before another mutation.
- The workflow may open the writer center and navigate known pages, but it must not enter credentials or bypass platform controls.

## Existing platform bootstrap

- Chapters already published before ledger tracking are imported as legacy platform states.
- Existing drafts and schedules are reconciled by chapter number and content/version evidence.
- A mismatch between an existing platform version and the current source creates a version conflict.

## Explicitly deferred

- Server-side headless browser execution.
- Multiple accounts or multiple works in one run.
- Automatic CAPTCHA/risk-control handling.
- Automatic chapter splitting or rewriting to fit a quota.
- Automatic cancellation or replacement of an existing Fanqie schedule.
