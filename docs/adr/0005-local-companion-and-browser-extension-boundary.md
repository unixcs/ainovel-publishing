# Separate the local companion from the browser extension

A lightweight application on the publishing computer owns SSH connectivity, incremental synchronization, durable local caching, reconnection, and a localhost API. The Chrome extension owns publishing-queue UI, preview, Fanqie editor interaction, and verification. This avoids exposing the manuscript API publicly and keeps filesystem and connection management out of the browser extension.
