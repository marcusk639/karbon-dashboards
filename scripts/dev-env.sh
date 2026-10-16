#!/usr/bin/env bash
# Run a command with the Karbon dashboards secrets loaded from the macOS Keychain.
#   scripts/dev-env.sh npm run reconcile
#   LIVE=1 scripts/dev-env.sh npx vitest run test/live
#
# One-time setup (each prompts for the value; nothing is echoed or stored in a file):
#   security add-generic-password -s karbon-dashboards -a snowflake-user -w
#   security add-generic-password -s karbon-dashboards -a snowflake-password -w
#   security add-generic-password -s karbon-dashboards -a mcp-bearer -w
set -euo pipefail

if [ "$#" -eq 0 ]; then
  echo "usage: scripts/dev-env.sh <command> [args...]" >&2
  exit 2
fi

secret() {
  security find-generic-password -s karbon-dashboards -a "$1" -w 2>/dev/null || {
    echo "dev-env: Keychain entry karbon-dashboards/$1 not found" >&2
    exit 1
  }
}

KARBON_SF_USER="$(secret snowflake-user)"
KARBON_SF_PASSWORD="$(secret snowflake-password)"
MCP_BEARER_TOKEN="$(secret mcp-bearer)"
export KARBON_SF_USER KARBON_SF_PASSWORD MCP_BEARER_TOKEN

exec "$@"
