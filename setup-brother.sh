#!/usr/bin/env bash
# Setup claude-peers-cloud MCP on a second machine.
#
# The token is NEVER stored in this file. Pass it as an argument:
#   bash setup-brother.sh <TOKEN> [owner]
#
# Or, without cloning this repo at all (recommended for a remote machine):
#   curl -fsSL https://claude-peers-cloud-production.up.railway.app/install | bash -s -- <TOKEN> <owner>
set -euo pipefail

BROKER_URL="${CLAUDE_PEERS_BROKER_URL:-https://claude-peers-cloud-production.up.railway.app}"
TOKEN="${1:-${CLAUDE_PEERS_TOKEN:-}}"
OWNER="${2:-${CLAUDE_PEERS_OWNER:-$(whoami)}}"

if [ -z "$TOKEN" ]; then
  echo "error: no token given." >&2
  echo "usage: bash setup-brother.sh <TOKEN> [owner]" >&2
  exit 1
fi

exec bash -c "$(curl -fsSL "$BROKER_URL/install")" -- "$TOKEN" "$OWNER"
