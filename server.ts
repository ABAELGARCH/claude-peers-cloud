#!/usr/bin/env bun
/**
 * claude-peers-cloud MCP server
 *
 * Spawned by Claude Code as a stdio MCP server (one per instance).
 * Connects to a REMOTE broker (deployed on Railway) so Claude Code instances
 * on different machines can talk to each other.
 *
 * Usage:
 *   claude --dangerously-load-development-channels server:claude-peers-cloud
 *
 * Required env (set in .mcp.json or shell):
 *   CLAUDE_PEERS_BROKER_URL  e.g. https://my-broker.up.railway.app
 *   CLAUDE_PEERS_TOKEN       shared secret between you and your peer
 *   CLAUDE_PEERS_OWNER       your display name, e.g. "hamza" or "brother"
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type {
  PeerId,
  Peer,
  RegisterResponse,
  PollMessagesResponse,
  Message,
} from "./shared/types.ts";

// --- Configuration ---

const BROKER_URL = (process.env.CLAUDE_PEERS_BROKER_URL ?? "http://127.0.0.1:7899").replace(/\/$/, "");
const TOKEN = process.env.CLAUDE_PEERS_TOKEN ?? "";
const OWNER = process.env.CLAUDE_PEERS_OWNER ?? process.env.USER ?? "anon";
const POLL_INTERVAL_MS = 1000;
const HEARTBEAT_INTERVAL_MS = 15_000;

// --- Broker communication ---

async function brokerFetch<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${BROKER_URL}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {}),
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Broker error (${path}): ${res.status} ${err}`);
  }
  return res.json() as Promise<T>;
}

async function isBrokerAlive(): Promise<boolean> {
  try {
    const res = await fetch(`${BROKER_URL}/health`, {
      headers: TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {},
      signal: AbortSignal.timeout(3000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

// --- Utility ---

function log(msg: string) {
  console.error(`[claude-peers-cloud] ${msg}`);
}

async function getGitRoot(cwd: string): Promise<string | null> {
  try {
    const proc = Bun.spawn(["git", "rev-parse", "--show-toplevel"], {
      cwd,
      stdout: "pipe",
      stderr: "ignore",
    });
    const text = await new Response(proc.stdout).text();
    const code = await proc.exited;
    if (code === 0) return text.trim();
  } catch {
    /* not a git repo */
  }
  return null;
}

// --- State ---

let myId: PeerId | null = null;
let myCwd = process.cwd();
let myGitRoot: string | null = null;

// --- MCP Server ---

const mcp = new Server(
  { name: "claude-peers-cloud", version: "0.1.0" },
  {
    capabilities: {
      experimental: { "claude/channel": {} },
      tools: {},
    },
    instructions: `You are connected to the claude-peers-cloud network. Other Claude Code instances on DIFFERENT machines (e.g. a teammate or sibling) can see you and send you messages.

IMPORTANT: When you receive a <channel source="claude-peers-cloud" ...> message, RESPOND IMMEDIATELY. Pause what you are doing, reply using send_message, then resume. Treat it like a coworker tapping you on the shoulder.

Read the from_id, from_owner, from_summary, and from_cwd attributes to understand who sent it. Reply with send_message to their from_id.

Available tools:
- list_peers: Discover other Claude Code instances across the network (scope: network/directory/repo)
- send_message: Send a message to another instance by ID
- set_summary: Set a 1-2 sentence summary of what you're working on (visible to peers)
- check_messages: Manually check for new messages

When you start, proactively call set_summary to describe your work.`,
  }
);

// --- Tool definitions ---

const TOOLS = [
  {
    name: "list_peers",
    description:
      "List other Claude Code instances on the shared network (across machines). Returns their ID, owner name, working directory, git repo, and summary.",
    inputSchema: {
      type: "object" as const,
      properties: {
        scope: {
          type: "string" as const,
          enum: ["network", "directory", "repo"],
          description:
            'Scope of peer discovery. "network" = all instances on the shared cloud broker. "directory" = same working directory. "repo" = same git repo.',
        },
      },
      required: ["scope"],
    },
  },
  {
    name: "send_message",
    description:
      "Send a message to another Claude Code instance by peer ID. Arrives in their session immediately via channel notification.",
    inputSchema: {
      type: "object" as const,
      properties: {
        to_id: { type: "string" as const, description: "The peer ID (from list_peers)" },
        message: { type: "string" as const, description: "The message to send" },
      },
      required: ["to_id", "message"],
    },
  },
  {
    name: "set_summary",
    description:
      "Set a brief summary (1-2 sentences) of what you are working on. Visible to other instances when they list peers.",
    inputSchema: {
      type: "object" as const,
      properties: {
        summary: { type: "string" as const, description: "A 1-2 sentence summary of your current work" },
      },
      required: ["summary"],
    },
  },
  {
    name: "check_messages",
    description: "Manually check for new messages from other Claude Code instances.",
    inputSchema: { type: "object" as const, properties: {} },
  },
];

// --- Tool handlers ---

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;

  switch (name) {
    case "list_peers": {
      const scope = (args as { scope: string }).scope as "network" | "directory" | "repo";
      try {
        const peers = await brokerFetch<Peer[]>("/list-peers", {
          scope,
          cwd: myCwd,
          git_root: myGitRoot,
          exclude_id: myId ?? undefined,
        });
        if (peers.length === 0) {
          return { content: [{ type: "text" as const, text: `No other peers found (scope: ${scope}).` }] };
        }
        const lines = peers.map((p) => {
          const parts = [`ID: ${p.id}`, `Owner: ${p.owner}`, `CWD: ${p.cwd}`];
          if (p.git_root) parts.push(`Repo: ${p.git_root}`);
          if (p.summary) parts.push(`Summary: ${p.summary}`);
          parts.push(`Last seen: ${p.last_seen}`);
          return parts.join("\n  ");
        });
        return {
          content: [{ type: "text" as const, text: `Found ${peers.length} peer(s) (scope: ${scope}):\n\n${lines.join("\n\n")}` }],
        };
      } catch (e) {
        return { content: [{ type: "text" as const, text: `Error listing peers: ${e instanceof Error ? e.message : String(e)}` }], isError: true };
      }
    }

    case "send_message": {
      const { to_id, message } = args as { to_id: string; message: string };
      if (!myId) return { content: [{ type: "text" as const, text: "Not registered with broker yet" }], isError: true };
      try {
        const result = await brokerFetch<{ ok: boolean; error?: string }>("/send-message", {
          from_id: myId,
          to_id,
          text: message,
        });
        if (!result.ok) {
          return { content: [{ type: "text" as const, text: `Failed to send: ${result.error}` }], isError: true };
        }
        return { content: [{ type: "text" as const, text: `Message sent to peer ${to_id}` }] };
      } catch (e) {
        return { content: [{ type: "text" as const, text: `Error sending message: ${e instanceof Error ? e.message : String(e)}` }], isError: true };
      }
    }

    case "set_summary": {
      const { summary } = args as { summary: string };
      if (!myId) return { content: [{ type: "text" as const, text: "Not registered with broker yet" }], isError: true };
      try {
        await brokerFetch("/set-summary", { id: myId, summary });
        return { content: [{ type: "text" as const, text: `Summary updated: "${summary}"` }] };
      } catch (e) {
        return { content: [{ type: "text" as const, text: `Error setting summary: ${e instanceof Error ? e.message : String(e)}` }], isError: true };
      }
    }

    case "check_messages": {
      if (!myId) return { content: [{ type: "text" as const, text: "Not registered with broker yet" }], isError: true };
      try {
        const result = await brokerFetch<PollMessagesResponse>("/poll-messages", { id: myId });
        if (result.messages.length === 0) return { content: [{ type: "text" as const, text: "No new messages." }] };
        const lines = result.messages.map(
          (m) => `From ${m.from_owner} (${m.from_id}) at ${m.sent_at}:\n${m.text}`
        );
        return { content: [{ type: "text" as const, text: `${result.messages.length} new message(s):\n\n${lines.join("\n\n---\n\n")}` }] };
      } catch (e) {
        return { content: [{ type: "text" as const, text: `Error checking messages: ${e instanceof Error ? e.message : String(e)}` }], isError: true };
      }
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
});

// --- Polling loop ---

async function pollAndPushMessages() {
  if (!myId) return;
  try {
    const result = await brokerFetch<PollMessagesResponse>("/poll-messages", { id: myId });
    for (const msg of result.messages) {
      let fromSummary = "";
      let fromCwd = "";
      try {
        const peers = await brokerFetch<Peer[]>("/list-peers", { scope: "network", cwd: myCwd, git_root: myGitRoot });
        const sender = peers.find((p) => p.id === msg.from_id);
        if (sender) {
          fromSummary = sender.summary;
          fromCwd = sender.cwd;
        }
      } catch {
        /* non-critical */
      }
      await mcp.notification({
        method: "notifications/claude/channel",
        params: {
          content: msg.text,
          meta: {
            from_id: msg.from_id,
            from_owner: msg.from_owner,
            from_summary: fromSummary,
            from_cwd: fromCwd,
            sent_at: msg.sent_at,
          },
        },
      });
      log(`Pushed message from ${msg.from_owner}: ${msg.text.slice(0, 80)}`);
    }
  } catch (e) {
    log(`Poll error: ${e instanceof Error ? e.message : String(e)}`);
  }
}

// --- Startup ---

async function main() {
  myCwd = process.cwd();
  myGitRoot = await getGitRoot(myCwd);

  log(`Broker: ${BROKER_URL}`);
  log(`Owner: ${OWNER}`);
  log(`CWD: ${myCwd}`);
  log(`Git root: ${myGitRoot ?? "(none)"}`);

  if (!(await isBrokerAlive())) {
    throw new Error(`Broker unreachable at ${BROKER_URL}. Check CLAUDE_PEERS_BROKER_URL and CLAUDE_PEERS_TOKEN.`);
  }

  const reg = await brokerFetch<RegisterResponse>("/register", {
    owner: OWNER,
    cwd: myCwd,
    git_root: myGitRoot,
    summary: `Claude Code on ${OWNER}'s machine`,
  });
  myId = reg.id;
  log(`Registered as peer ${myId}`);

  // Heartbeat so the broker doesn't drop us as stale
  setInterval(() => {
    if (myId) brokerFetch("/heartbeat", { id: myId }).catch(() => {});
  }, HEARTBEAT_INTERVAL_MS);

  // Poll for inbound messages
  setInterval(pollAndPushMessages, POLL_INTERVAL_MS);

  const transport = new StdioServerTransport();
  await mcp.connect(transport);
  log("MCP server connected");

  // Unregister on exit
  const cleanup = async () => {
    if (myId) await brokerFetch("/unregister", { id: myId }).catch(() => {});
    process.exit(0);
  };
  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);
}

main().catch((e) => {
  log(`Fatal: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
