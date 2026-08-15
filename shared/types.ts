// Shared types for the cloud claude-peers broker.
// Mirrors the local broker API but adds a `name`/`owner` field so two people
// on different machines can identify each other.

export type PeerId = string;

export interface Peer {
  id: PeerId;
  owner: string; // display name, e.g. "hamza" or "brother"
  cwd: string;
  git_root: string | null;
  summary: string;
  registered_at: string;
  last_seen: string;
}

export interface Message {
  id: number;
  from_id: PeerId;
  from_owner: string;
  to_id: PeerId;
  text: string;
  sent_at: string;
  delivered: boolean;
}

// --- Broker API types ---

export interface RegisterRequest {
  owner: string;
  cwd: string;
  git_root: string | null;
  summary: string;
}

export interface RegisterResponse {
  id: PeerId;
}

export interface HeartbeatRequest {
  id: PeerId;
}

export interface SetSummaryRequest {
  id: PeerId;
  summary: string;
}

export interface ListPeersRequest {
  scope: "network" | "directory" | "repo";
  cwd: string;
  git_root: string | null;
  exclude_id?: PeerId;
}

export interface SendMessageRequest {
  from_id: PeerId;
  to_id: PeerId;
  text: string;
}

export interface PollMessagesRequest {
  id: PeerId;
}

export interface PollMessagesResponse {
  messages: Message[];
}
