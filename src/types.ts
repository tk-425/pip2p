/**
 * pip2p - Pi-to-Pi Multi-Agent Communication Extension
 * Type definitions
 */

export type ActivityState = "idle" | "running" | "unknown";

export type InboxDeliveryMode = "default" | "auto-inject";

export interface ProjectSettings {
  coordinatorInboxDeliveryMode: InboxDeliveryMode;
}

export interface AgentInfo {
  name: string;
  pid: number;
  startedAt: number;
  isCoordinator: boolean;
  cwd: string;
  activity: ActivityState;
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

export type MessageType =
  | "task"
  | "response"
  | "message"
  | "invoke-skill"
  | "approval-request"
  | "approval-decision"
  | "thread-resolved";

export type SkillReplyMode = "auto" | "interactive";

export interface TaskContext {
  originalRequest?: string;
  constraints?: string[];
  expectedResult?: string;
  fallbackPolicy?: string;
}

export interface SkillInvocation {
  skillName: string;
  args?: string;
  replyMode?: SkillReplyMode;
}

export interface ApprovalRequest {
  requestId: string;
  threadId?: string;
  actionType: string;
  title: string;
  summary: string;
  details?: string;
  commands?: string[];
  files?: string[];
  metadata?: Record<string, string>;
  requestedAt: number;
}

export interface ApprovalDecision {
  requestId: string;
  decision: "approved" | "rejected";
  note?: string;
  decidedAt: number;
}

export interface ThreadResolution {
  threadId: string;
  sender: string;
}

export type PendingApprovalStatus = "pending" | "approved" | "rejected" | "resolved-local" | "resolved-remote";
export type PendingApprovalWinner = "local-user" | "agent";

export interface PendingApprovalEntry {
  requester: string;
  request: ApprovalRequest;
  status: PendingApprovalStatus;
  winner?: PendingApprovalWinner;
  decision?: ApprovalDecision["decision"];
  note?: string;
  resolvedAt?: number;
}

export interface PipMessage {
  id: string;
  from: string;
  to: string;
  content: string;
  timestamp: number;
  read: boolean;
  type: MessageType;
  threadId?: string;
  inReplyTo?: string;
  skillInvocation?: SkillInvocation;
  approvalRequest?: ApprovalRequest;
  approvalDecision?: ApprovalDecision;
  threadResolution?: ThreadResolution;
  invokeThreadId?: string;
  taskContext?: TaskContext;
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

export interface WsSetActivityMessage {
  type: "set_activity";
  agent: string;
  activity: ActivityState;
}

export type WsClientMessage = WsRegisterMessage | WsMessagePayload | WsHeartbeatMessage | WsSetActivityMessage;

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

export interface WsActivityChangedBroadcast {
  type: "activity_changed";
  agent: string;
  activity: ActivityState;
}

export type WsServerMessage =
  | WsRegistryBroadcast
  | WsMessageBroadcast
  | WsAgentJoinedBroadcast
  | WsAgentLeftBroadcast
  | WsActivityChangedBroadcast;
