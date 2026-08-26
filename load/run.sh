#!/usr/bin/env bash
# Ingest ACK latency smoke test (M1 DoD: p95 < 100ms locally under a burst).
# Assumes the compose stack and apps/api are already running.
set -euo pipefail
cd "$(dirname "$0")/.."

KEY=$(pnpm --filter @ironside/api --silent seed | grep 'api key' | awk '{print $3}')
export IRONSIDE_LOAD_TEST_KEY="$KEY"

npx --yes artillery@2.0.33 run load/ingest.yml
