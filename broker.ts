#!/usr/bin/env bun
/**
 * claude-peers-cloud broker daemon
 *
 * A singleton HTTP server backed by SQLite. Runs in the cloud (Railway) so
 * that Claude Code instances on DIFFERENT machines can find each other and
 * exchange messages.
 *
 * Every request must carry `Authorization: Bearer <CLAUDE_PEERS_TOKEN>`.
 * Deploy: Railway Dockerfile + railway.toml (see repo root).
 */

import { Database } from "bun:sqlite";
import type {
  RegisterRequest,
  RegisterResponse,
  HeartbeatRequest,
  SetSummaryRequest,
  ListPeersRequest,
  SendMessageRequest,
  PollMessagesRequest,
  PollMessagesResponse,
  Peer,
  Message,
} from "./shared/types.ts";

const PORT = parseInt(process.env.PORT ?? process.env.CLAUDE_PEERS_PORT ?? "3000", 10);
const DB_PATH = process.env.CLAUDE_PEERS_DB ?? `${process.env.HOME ?? "/tmp"}/.claude-peers-cloud.db`;
const TOKEN = process.env.CLAUDE_PEERS_TOKEN ?? "";
const STALE_MS = 2 * 60 * 1000; // drop peers not seen in 2 minutes

// --- Database setup ---

const db = new Database(DB_PATH);
db.run("PRAGMA journal_mode = WAL");
db.run("PRAGMA busy_timeout = 3000");

db.run(`
  CREATE TABLE IF NOT EXISTS peers (
    id TEXT PRIMARY KEY,
    owner TEXT NOT NULL,
    cwd TEXT NOT NULL,
    git_root TEXT,
    summary TEXT NOT NULL DEFAULT '',
    registered_at TEXT NOT NULL,
    last_seen TEXT NOT NULL
  )
`);

db.run(`
  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    from_id TEXT NOT NULL,
    from_owner TEXT NOT NULL,
    to_id TEXT NOT NULL,
    text TEXT NOT NULL,
    sent_at TEXT NOT NULL,
    delivered INTEGER NOT NULL DEFAULT 0,
    FOREIGN KEY (from_id) REFERENCES peers(id),
    FOREIGN KEY (to_id) REFERENCES peers(id)
  )
`);

function cleanStalePeers() {
  const cutoff = Date.now() - STALE_MS;
  const peers = db.query("SELECT id, last_seen FROM peers").all() as { id: string; last_seen: string }[];
  for (const peer of peers) {
    const seen = new Date(peer.last_seen).getTime();
    if (Number.isNaN(seen) || seen < cutoff) {
      db.run("DELETE FROM peers WHERE id = ?", [peer.id]);
      db.run("DELETE FROM messages WHERE to_id = ? AND delivered = 0", [peer.id]);
    }
  }
}

cleanStalePeers();
setInterval(cleanStalePeers, 30_000);

// --- Prepared statements ---

const insertPeer = db.prepare(`
  INSERT INTO peers (id, owner, cwd, git_root, summary, registered_at, last_seen)
  VALUES (?, ?, ?, ?, ?, ?, ?)
`);
const updateLastSeen = db.prepare(`UPDATE peers SET last_seen = ? WHERE id = ?`);
const updateSummary = db.prepare(`UPDATE peers SET summary = ? WHERE id = ?`);
const deletePeer = db.prepare(`DELETE FROM peers WHERE id = ?`);
const selectAllPeers = db.prepare(`SELECT * FROM peers`);
const selectPeersByDirectory = db.prepare(`SELECT * FROM peers WHERE cwd = ?`);
const selectPeersByGitRoot = db.prepare(`SELECT * FROM peers WHERE git_root = ?`);
const insertMessage = db.prepare(`
  INSERT INTO messages (from_id, from_owner, to_id, text, sent_at, delivered)
  VALUES (?, ?, ?, ?, ?, 0)
`);
const selectUndelivered = db.prepare(
  `SELECT * FROM messages WHERE to_id = ? AND delivered = 0 ORDER BY sent_at ASC`
);
const markDelivered = db.prepare(`UPDATE messages SET delivered = 1 WHERE id = ?`);

function generateId(): string {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  let id = "";
  for (let i = 0; i < 8; i++) id += chars[Math.floor(Math.random() * chars.length)];
  return id;
}

// --- Request handlers ---

function handleRegister(body: RegisterRequest): RegisterResponse {
  const id = generateId();
  const now = new Date().toISOString();
  insertPeer.run(id, body.owner, body.cwd, body.git_root ?? null, body.summary ?? "", now, now);
  return { id };
}

function handleHeartbeat(body: HeartbeatRequest): void {
  updateLastSeen.run(new Date().toISOString(), body.id);
}

function handleSetSummary(body: SetSummaryRequest): void {
  updateSummary.run(body.summary, body.id);
}

function handleListPeers(body: ListPeersRequest): Peer[] {
  let peers: Peer[];
  switch (body.scope) {
    case "directory":
      peers = selectPeersByDirectory.all(body.cwd) as Peer[];
      break;
    case "repo":
      peers = body.git_root
        ? (selectPeersByGitRoot.all(body.git_root) as Peer[])
        : (selectPeersByDirectory.all(body.cwd) as Peer[]);
      break;
    case "network":
    default:
      peers = selectAllPeers.all() as Peer[];
  }
  if (body.exclude_id) peers = peers.filter((p) => p.id !== body.exclude_id);
  // Only return live peers (within STALE_MS)
  const cutoff = Date.now() - STALE_MS;
  return peers.filter((p) => {
    const seen = new Date(p.last_seen).getTime();
    if (Number.isNaN(seen) || seen < cutoff) {
      deletePeer.run(p.id);
      return false;
    }
    return true;
  });
}

function handleSendMessage(body: SendMessageRequest): { ok: boolean; error?: string } {
  const target = db.query("SELECT id, owner FROM peers WHERE id = ?").get(body.to_id) as
    | { id: string; owner: string }
    | null;
  if (!target) return { ok: false, error: `Peer ${body.to_id} not found` };
  const from = db.query("SELECT owner FROM peers WHERE id = ?").get(body.from_id) as
    | { owner: string }
    | null;
  insertMessage.run(body.from_id, from?.owner ?? "unknown", body.to_id, body.text, new Date().toISOString());
  return { ok: true };
}

function handlePollMessages(body: PollMessagesRequest): PollMessagesResponse {
  const messages = selectUndelivered.all(body.id) as Message[];
  for (const msg of messages) markDelivered.run(msg.id);
  return { messages };
}

function handleUnregister(body: { id: string }): void {
  deletePeer.run(body.id);
}

// --- Bootstrap (unauthenticated) ---
//
// A new machine can install the MCP client without any GitHub access:
//   curl -fsSL https://<broker>/install | bash -s -- <TOKEN> <owner>
//
// Only the client-side files are served, and only from this explicit
// allowlist. broker.ts, .env* and everything else stay unreachable.

const SERVABLE_FILES = new Set(["server.ts", "package.json", "shared/types.ts"]);

function installScript(brokerUrl: string): string {
  return `#!/usr/bin/env bash
# claude-peers-cloud installer
# Usage: curl -fsSL ${brokerUrl}/install | bash -s -- <TOKEN> [owner]
set -euo pipefail

BROKER_URL="${brokerUrl}"
TOKEN="\${1:-\${CLAUDE_PEERS_TOKEN:-}}"
OWNER="\${2:-\${CLAUDE_PEERS_OWNER:-\$(whoami)}}"
DIR="\${CLAUDE_PEERS_DIR:-\$HOME/claude-peers-cloud}"

if [ -z "\$TOKEN" ]; then
  echo "error: no token given." >&2
  echo "usage: curl -fsSL \$BROKER_URL/install | bash -s -- <TOKEN> [owner]" >&2
  exit 1
fi

command -v bun >/dev/null || { echo "error: bun is required (https://bun.sh)" >&2; exit 1; }
command -v claude >/dev/null || { echo "error: claude CLI is required" >&2; exit 1; }

echo "==> Fetching client into \$DIR"
mkdir -p "\$DIR/shared"
for f in server.ts package.json shared/types.ts; do
  curl -fsSL "\$BROKER_URL/files/\$f" -o "\$DIR/\$f"
done

echo "==> Installing dependencies"
(cd "\$DIR" && bun install)

echo "==> Registering MCP server (owner: \$OWNER)"
claude mcp remove --scope user claude-peers-cloud 2>/dev/null || true
claude mcp add --scope user --transport stdio claude-peers-cloud \\
  --env CLAUDE_PEERS_BROKER_URL="\$BROKER_URL" \\
  --env CLAUDE_PEERS_TOKEN="\$TOKEN" \\
  --env CLAUDE_PEERS_OWNER="\$OWNER" \\
  -- bun "\$DIR/server.ts"

echo
echo "==> Done. Start Claude Code with:"
echo "    claude --dangerously-load-development-channels server:claude-peers-cloud"
echo "==> Then ask: 'List all peers on the network'"
`;
}

// --- HTTP Server ---

function authorized(req: Request): boolean {
  if (!TOKEN) return true; // dev mode: no token required
  const auth = req.headers.get("authorization") ?? "";
  return auth === `Bearer ${TOKEN}`;
}

Bun.serve({
  port: PORT,
  hostname: "0.0.0.0",
  async fetch(req) {
    const url = new URL(req.url);
    const path = url.pathname;

    // health check (no auth)
    if (path === "/health") {
      return Response.json({ status: "ok", peers: (selectAllPeers.all() as Peer[]).length });
    }

    // bootstrap (no auth): install script + client-side source files
    if (path === "/install" && req.method === "GET") {
      return new Response(installScript(url.origin), {
        headers: { "Content-Type": "text/plain; charset=utf-8" },
      });
    }

    if (path.startsWith("/files/") && req.method === "GET") {
      const name = path.slice("/files/".length);
      if (!SERVABLE_FILES.has(name)) {
        return Response.json({ error: "not found" }, { status: 404 });
      }
      const file = Bun.file(`${import.meta.dir}/${name}`);
      if (!(await file.exists())) {
        return Response.json({ error: "not found" }, { status: 404 });
      }
      return new Response(file, { headers: { "Content-Type": "text/plain; charset=utf-8" } });
    }

    if (!authorized(req)) {
      return Response.json({ error: "unauthorized" }, { status: 401 });
    }

    if (req.method !== "POST") {
      return new Response("claude-peers-cloud broker", { status: 200 });
    }

    try {
      const body = await req.json();
      switch (path) {
        case "/register":
          return Response.json(handleRegister(body as RegisterRequest));
        case "/heartbeat":
          handleHeartbeat(body as HeartbeatRequest);
          return Response.json({ ok: true });
        case "/set-summary":
          handleSetSummary(body as SetSummaryRequest);
          return Response.json({ ok: true });
        case "/list-peers":
          return Response.json(handleListPeers(body as ListPeersRequest));
        case "/send-message":
          return Response.json(handleSendMessage(body as SendMessageRequest));
        case "/poll-messages":
          return Response.json(handlePollMessages(body as PollMessagesRequest));
        case "/unregister":
          handleUnregister(body as { id: string });
          return Response.json({ ok: true });
        default:
          return Response.json({ error: "not found" }, { status: 404 });
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return Response.json({ error: msg }, { status: 500 });
    }
  },
});

console.error(`[claude-peers-cloud broker] listening on 0.0.0.0:${PORT}`);
