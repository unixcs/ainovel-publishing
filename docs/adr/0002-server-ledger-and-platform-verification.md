# Server ledger with platform-verified publication state

The server stores the durable publishing ledger because extension-local storage is disposable and the manuscript already originates on the server. Fanqie remains authoritative for whether a chapter is a draft, published, or otherwise accepted: the workflow records those transitions only after verification from the platform, and reconciles ambiguous results before retrying.
