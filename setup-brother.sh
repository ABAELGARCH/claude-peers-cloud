#!/usr/bin/env bash
# Setup claude-peers-cloud MCP on your brother's machine (one command).
# Usage: bash setup-brother.sh
set -e

REPO_DIR="$HOME/claude-peers-cloud"
BROKER_URL="https://claude-peers-cloud-production.up.railway.app"
TOKEN="2f8e9b1c4d6a7e0f3b5c8d1a2e4f6b9c0d3e5f7a8b1c2d4e6f8a0b2c4d6e8f0"
OWNER="brother"

echo "==> Cloning repo..."
if [ ! -d "$REPO_DIR" ]; then
  git clone https://github.com/ABAELGARCH/claude-peers-cloud.git "$REPO_DIR"
fi
cd "$REPO_DIR"
bun install

echo "==> Registering MCP server (owner: $OWNER)..."
claude mcp add --scope user --transport stdio claude-peers-cloud \
  --env CLAUDE_PEERS_BROKER_URL="$BROKER_URL" \
  --env CLAUDE_PEERS_TOKEN="$TOKEN" \
  --env CLAUDE_PEERS_OWNER="$OWNER" \
  -- bun "$REPO_DIR/server.ts"

echo "==> Done. Start Claude Code with:"
echo "    claude --dangerously-load-development-channels server:claude-peers-cloud"
echo "==> Then ask: 'List all peers on the network'"
