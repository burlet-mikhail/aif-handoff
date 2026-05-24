#!/bin/sh
# Resilient apt-get install wrapper for Docker builds.
#
# Handles transient Debian mirror / CDN failures observed during build:
#   - "Hash Sum mismatch" — CDN serves stale .deb that disagrees with the
#     freshly downloaded Packages index. Same filesize, different SHA →
#     network-layer substitution (intermediate caching proxy or partially
#     synced mirror). `Acquire::http::No-Cache=true` forces upstream re-fetch;
#     wiping /var/lib/apt/lists between attempts re-pulls the index so a
#     poisoned index doesn't keep poisoning subsequent installs.
#   - Sporadic 5xx / connection resets on deb.debian.org — covered by the
#     built-in `Acquire::Retries=5` (per-file retry inside a single invocation)
#     plus the outer 3-attempt loop (re-do update+install from scratch).
#
# Always cleans /var/lib/apt/lists/* on exit so callers don't have to chain
# `&& rm -rf` to keep image size down.
set -eu

APT_OPTS="-o Acquire::Retries=5 -o Acquire::http::No-Cache=true"
MAX_ATTEMPTS=3

cleanup() {
    rm -rf /var/lib/apt/lists/*
}
trap cleanup EXIT

attempt=1
while [ "$attempt" -le "$MAX_ATTEMPTS" ]; do
    if apt-get update $APT_OPTS \
        && apt-get install -y --no-install-recommends $APT_OPTS "$@"; then
        exit 0
    fi
    if [ "$attempt" -eq "$MAX_ATTEMPTS" ]; then
        echo "apt-install: failed after $MAX_ATTEMPTS attempts" >&2
        exit 1
    fi
    echo "apt-install: attempt $attempt/$MAX_ATTEMPTS failed; clearing apt lists and retrying..." >&2
    rm -rf /var/lib/apt/lists/*
    sleep $((attempt * 5))
    attempt=$((attempt + 1))
done
