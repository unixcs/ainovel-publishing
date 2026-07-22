#!/usr/bin/env bash
set -euo pipefail

: "${REMOTE:?Set REMOTE, for example deploy@your-server.example.com}"
: "${REMOTE_RELEASE_ROOT:?Set REMOTE_RELEASE_ROOT to the server release directory}"
LOCAL_ROOT="${1:-./downloads/release}"

mkdir -p "$LOCAL_ROOT/reports" "$LOCAL_ROOT/ready" "$LOCAL_ROOT/chapters"

scp "$REMOTE:$REMOTE_RELEASE_ROOT/latest-batch.zip" "$LOCAL_ROOT/"
scp "$REMOTE:$REMOTE_RELEASE_ROOT/manifest.jsonl" "$LOCAL_ROOT/"
scp "$REMOTE:$REMOTE_RELEASE_ROOT/reports/latest-report.json" "$LOCAL_ROOT/reports/"
scp "$REMOTE:$REMOTE_RELEASE_ROOT/reports/latest-report.txt" "$LOCAL_ROOT/reports/"

echo "Downloaded release artifacts to: $LOCAL_ROOT"
