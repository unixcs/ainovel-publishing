# Fanqie automation landscape review

Reviewed: 2026-07-22. This is a planning reference, not a dependency decision.

## `hchcx/fanqie_auto_publish`

- Repository: <https://github.com/hchcx/fanqie_auto_publish>
- GitHub metadata at review: 227 stars, updated 2026-07-21, no declared license.
- Useful ideas: persistent local browser state, chapter-list reconciliation, handling a newly opened editor tab, and an end-to-end path through “下一步”, typo confirmation, AI declaration, and final publish.
- Rejected as a direct dependency: broad `force`/coordinate clicks, fixed sleeps, swallowed exceptions, a risk-dialog fallback that clicks “取消”, and paths that count a chapter as successful or move its file after an unverified action. Its local `state.json` model also does not integrate with this project's SQLite ledger and source hashes.

## `Fitia-UCAS/fanqie-publish-sync`

- Repository: <https://github.com/Fitia-UCAS/fanqie-publish-sync>
- GitHub metadata at review: updated 2026-07-16, no declared license.
- Useful ideas: clear separation of domain, platform adapter, syncing, persistence, task/runtime, and UI modules; explicit publishing and verification services.
- Rejected as a direct dependency because licensing is unspecified and its application shape does not match the existing Windows companion plus browser-extension boundary. Its module boundaries are a useful design reference.

## `Kirby980/auto-fanqie`

- Repository: <https://github.com/Kirby980/auto-fanqie>
- GitHub metadata at review: updated 2026-07-13, no declared license.
- Useful ideas: a standalone validation/counting command, a browser automation wrapper, and a workflow skill around Fanqie publication.
- Rejected as a direct dependency because licensing is unspecified and the repository contains generated/bundled artifacts and multiple runtime paths that would complicate provenance and security review.

## Decision

No external repository is copied into the product at this stage. The implementation will add a small, testable Fanqie state machine to the existing extension, put quota planning and durable checkpoints in the existing companion, and keep the logged-in browser local. Re-evaluate external adapters only after a project with an explicit compatible license and stable verified selectors appears.
