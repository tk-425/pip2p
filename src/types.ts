/**
 * pip2p - Pi-to-Pi Multi-Agent Communication Extension
 * Type definitions
 */

export interface AgentInfo {
  name: string;
  pid: number;
  startedAt: number;
  isCoordinator: boolean;
  cwd: string;
}

export interface AgentRegistry {
  agents: AgentInfo[];
}

export interface ServerInfo {
  port: number;
  coordinator: string;
  pid: number;
  startedAt: number;
}

export type MessageType = "task" | "response" | "message" | "invoke-skill";

export interface SkillInvocation {
  skillName: string;
  args?: string;
}

export interface PipMessage {
  id: string;
  from: string;
  to: string;
  content: string;
  timestamp: number;
  read: boolean;
  type: MessageType;
  inReplyTo?: string;
  skillInvocation?: SkillInvocation;
}

export type ConnectionStatus = "live" | "file";

// WebSocket protocol types

export interface WsRegisterMessage {
  type: "register";
  agent: { name: string; pid: number };
}

export interface WsMessagePayload {
  type: "message";
  to: string;
  payload: PipMessage;
}

export interface WsHeartbeatMessage {
  type: "heartbeat";
  agent: string;
}

export type WsClientMessage = WsRegisterMessage | WsMessagePayload | WsHeartbeatMessage;

export interface WsRegistryBroadcast {
  type: "registry";
  agents: AgentInfo[];
}

export interface WsMessageBroadcast {
  type: "message";
  payload: PipMessage;
}

export interface WsAgentJoinedBroadcast {
  type: "agent_joined";
  agent: AgentInfo;
}

export interface WsAgentLeftBroadcast {
  type: "agent_left";
  agent: string;
}

export type WsServerMessage =
  | WsRegistryBroadcast
  | WsMessageBroadcast
  | WsAgentJoinedBroadcast
  | WsAgentLeftBroadcast;
