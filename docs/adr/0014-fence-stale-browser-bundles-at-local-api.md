# Fence stale browser bundles at the local companion API

**Status: accepted**

An unpacked Edge extension can keep its old service worker alive after files on disk are replaced. That stale worker can otherwise read a new companion ledger and reach browser mutations with obsolete selectors before its first write fails. Every authenticated localhost API request therefore carries the exact extension bundle version and the companion rejects missing or mismatched versions before returning books, chapters, or plans. This sacrifices rolling compatibility between companion and extension versions in favor of preventing mixed-version browser automation; the unauthenticated health endpoint remains available to explain which version must be reloaded.
