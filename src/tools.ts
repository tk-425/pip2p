/**
 * Custom Tools - pip2p tools for agent communication
 */

import { Type } from "@sinclair/typebox";
import { getOtherAgents, readServerInfo } from "./agent-registry.js";
import { formatMessage } from "./skill-detect.js";
import { getEffectiveThreadId } from "./threading.js";
import type { MessageBus } from "./message-bus.js";
import type { WidgetManager } from "./widget-manager.js";
import type {
  AgentInfo,
  ApprovalDecision,
  ApprovalRequest,
  PendingApprovalEntry,
  PipMessage,
  MessageType,
  SkillReplyMode,
  TaskContext,
} from "./types.js";

export interface ToolContext {
  agentName: string | null;
  cwd: string;
  messageBus: MessageBus | null;
  widgetManager: WidgetManager | null;
  suppressInboxPollingThisTurn: boolean;
  currentPrompt: string;
  currentInboundMessage: PipMessage | null;
  pendingApprovals: Map<string, PendingApprovalEntry>;
}

type ReadyToolContext = {
  [K in keyof ToolContext]: NonNullable<ToolContext[K]>;
};

function getState(ctx: ToolContext): ReadyToolContext {
  if (!ctx.agentName || !ctx.messageBus || !ctx.widgetManager) {
    throw new Error("pip2p is not active in this session. Run /pip2p to start.");
  }
  return ctx as ReadyToolContext;
}

function getUnavailableLiveTargetResult(s: ReadyToolContext, agentName: string) {
  if (s.messageBus.getStatus() !== "live" || s.messageBus.getLiveAgents().some((agent) => agent.name === agentName)) {
    return null;
  }
  return {
    content: [{ type: "text" as const, text: `Agent "${agentName}" is not live and cannot receive a live message.` }],
    details: { error: "agent_not_live", status: s.messageBus.getStatus() },
  };
}

function userExplicitlyAskedToCheckInbox(prompt: string): boolean {
  const normalized = prompt.toLowerCase();
  return /\b(check|get|read|look at|inspect|poll|monitor)\b[\s\w]{0,40}\b(inbox|messages)\b/.test(normalized)
    || /\bwait\b[\s\w]{0,40}\b(reply|response|inbox|message)\b/.test(normalized);
}

function getObjectParam(params: unknown): Record<string, unknown> {
  return params && typeof params === "object" ? (params as Record<string, unknown>) : {};
}

function getStringParam(params: Record<string, unknown>, key: string): string | undefined {
  const value = params[key];
  return typeof value === "string" ? value : undefined;
}

function getStringArrayParam(params: Record<string, unknown>, key: string): string[] | undefined {
  const value = params[key];
  if (!Array.isArray(value)) return undefined;
  const strings = value.filter((item): item is string => typeof item === "string");
  return strings.length > 0 ? strings : undefined;
}

function getReplyModeParam(params: Record<string, unknown>): SkillReplyMode | undefined {
  const value = params.replyMode;
  return value === "auto" || value === "interactive" ? value : undefined;
}

function getApprovalDecisionParam(params: Record<string, unknown>): ApprovalDecision["decision"] | undefined {
  const value = params.decision;
  return value === "approved" || value === "rejected" ? value : undefined;
}

function getActiveThreadId(ctx: ToolContext): string | undefined {
  const inbound = ctx.currentInboundMessage;
  if (!inbound) return undefined;
  return getEffectiveThreadId(inbound);
}

/**
 * Create all pip2p tools
 */
export function createTools(toolCtx: ToolContext) {
  return [
    createSendToAgentTool(toolCtx),
    createInvokeSkillTool(toolCtx),
    createRequestApprovalTool(toolCtx),
    createRespondToApprovalTool(toolCtx),
    createResolveLocalApprovalTool(toolCtx),
    createGetInboxTool(toolCtx),
    createListAgentsTool(toolCtx),
    createReplyToAgentTool(toolCtx),
  ];
}

function createSendToAgentTool(ctx: ToolContext) {
  return {
    name: "send_to_agent",
    label: "Send to Agent",
    description: "Send a task or message to another agent in the pip2p network",
    promptGuidelines: [
      "Use send_to_agent to delegate work or send a message to another pip2p agent.",
      "Normalize the task for clarity, but preserve the user's explicit intent and constraints; do not invent tools or capabilities.",
      "If a task names a protocol or capability rather than a specific tool, let the receiving agent choose the best available matching capability.",
      "Only ask for clarification or report failure when no useful capability exists or an explicit constraint cannot be satisfied.",
      "After send_to_agent returns, do not wait for the other agent's reply in the same turn.",
      "After send_to_agent returns, do not call get_inbox in the same turn unless the user explicitly asks you to check messages immediately.",
    ],
    parameters: Type.Object({
      to: Type.String({ description: "Target agent name" }),
      message: Type.String({ description: "Normalized task or message; preserve explicit user intent and constraints" }),
      taskContext: Type.Optional(Type.Object({
        constraints: Type.Optional(Type.Array(Type.String(), { description: "Explicit requirements that must be preserved" })),
        expectedResult: Type.Optional(Type.String({ description: "Desired response shape or deliverable" })),
        fallbackPolicy: Type.Optional(Type.String({ description: "How to proceed when the preferred capability is unavailable" })),
      })),
      type: Type.Optional(
        Type.Union([Type.Literal("task"), Type.Literal("message")], {
          default: "task",
        }),
      ),
    }),
    async execute(_toolCallId: string, params: unknown) {
      const s = getState(ctx);
      const record = getObjectParam(params);
      const to = getStringParam(record, "to");
      const message = getStringParam(record, "message");
      const requestedType = getStringParam(record, "type");
      const rawTaskContext = getObjectParam(record.taskContext);
      const taskContext: TaskContext | undefined = Object.keys(rawTaskContext).length > 0 ? {
        constraints: getStringArrayParam(rawTaskContext, "constraints"),
        expectedResult: getStringParam(rawTaskContext, "expectedResult"),
        fallbackPolicy: getStringParam(rawTaskContext, "fallbackPolicy"),
      } : undefined;
      const type: MessageType = requestedType === "message" ? "message" : "task";
      const enrichedTaskContext = type === "task" && ctx.currentPrompt.trim()
        ? { ...taskContext, originalRequest: ctx.currentPrompt.trim() }
        : taskContext;

      if (!to || !message) {
        return {
          content: [{ type: "text" as const, text: 'Both "to" and "message" are required.' }],
          details: { error: "invalid_arguments" },
        };
      }

      const otherAgents = getOtherAgents(s.cwd, s.agentName);
      const target = otherAgents.find((a) => a.name === to);
      if (!target) {
        const available = otherAgents.map((a) => a.name).join(", ") || "none";
        return {
          content: [{ type: "text" as const, text: `Agent "${to}" not found. Available agents: ${available}` }],
          details: { error: "agent_not_found" },
        };
      }

      const unavailableTarget = getUnavailableLiveTargetResult(s, to);
      if (unavailableTarget) return unavailableTarget;

      const threadId = getActiveThreadId(ctx) ?? crypto.randomUUID();
      const sent = s.messageBus.sendMessage(to, message, type, { threadId, taskContext: enrichedTaskContext });
      const queued = s.messageBus.isMessageQueued(sent.id);
      ctx.suppressInboxPollingThisTurn = true;
      return {
        content: [{ type: "text" as const, text: queued
          ? `Message queued for ${to} until the agent is idle.`
          : `Message sent to ${to} (${s.messageBus.getStatus()} mode)` }],
        details: { messageId: sent.id, status: s.messageBus.getStatus(), type, queued },
      };
    },
  };
}

function createInvokeSkillTool(ctx: ToolContext) {
  return {
    name: "invoke_skill_on_agent",
    label: "Invoke Skill on Agent",
    description: "Send a structured skill invocation request to another agent. Defaults to interactive mode. In both interactive and auto modes, the request is sent now and this tool returns immediately; do not poll get_inbox in the same turn because replies and results arrive later.",
    promptGuidelines: [
      "Use invoke_skill_on_agent to delegate a skill invocation to another pip2p agent.",
      "After invoke_skill_on_agent returns, do not wait for the delegated agent's reply in the same turn.",
      "After invoke_skill_on_agent returns, do not call get_inbox in the same turn unless the user explicitly asks you to check messages immediately.",
    ],
    parameters: Type.Object({
      to: Type.String({ description: "Target agent name" }),
      skill: Type.String({ description: "Local skill name to invoke on the target agent" }),
      args: Type.Optional(Type.String({ description: "Arguments to append after the skill command" })),
      replyMode: Type.Optional(
        Type.Union([Type.Literal("auto"), Type.Literal("interactive")], {
          description: "Reply behavior: interactive sends immediately and does not wait; follow-up replies and results arrive later in your inbox. Auto is for one-shot requests where the final result arrives later in your inbox. In either mode, do not poll get_inbox in the same turn after calling this tool. Defaults to interactive.",
        }),
      ),
    }),
    async execute(_toolCallId: string, params: unknown) {
      const s = getState(ctx);
      const record = getObjectParam(params);
      const to = getStringParam(record, "to");
      const skill = getStringParam(record, "skill");
      const args = getStringParam(record, "args");
      const replyMode = getReplyModeParam(record) ?? "interactive";

      if (!to || !skill) {
        return {
          content: [{ type: "text" as const, text: 'Both "to" and "skill" are required.' }],
          details: { error: "invalid_arguments" },
        };
      }

      const otherAgents = getOtherAgents(s.cwd, s.agentName);
      const target = otherAgents.find((a) => a.name === to);
      if (!target) {
        const available = otherAgents.map((a) => a.name).join(", ") || "none";
        return {
          content: [{ type: "text" as const, text: `Agent "${to}" not found. Available agents: ${available}` }],
          details: { error: "agent_not_found" },
        };
      }

      const unavailableTarget = getUnavailableLiveTargetResult(s, to);
      if (unavailableTarget) return unavailableTarget;

      const threadId = getActiveThreadId(ctx) ?? crypto.randomUUID();
      const sent = s.messageBus.sendMessage(to, "Structured skill invocation request", "invoke-skill", {
        skillInvocation: {
          skillName: skill,
          args,
          replyMode,
        },
        threadId,
      });

      const queued = s.messageBus.isMessageQueued(sent.id);
      const responseText =
        replyMode === "auto"
          ? queued
            ? `Structured skill invocation queued for ${to} until the agent is idle. The final result will arrive in your inbox later.`
            : `Structured skill invocation sent to ${to} in auto mode. The final result will arrive in your inbox later. Do not poll get_inbox in this same turn.`
          : queued
            ? `Structured skill invocation queued for ${to} until the agent is idle. Follow-up replies and the final result will arrive in your inbox later.`
            : `Structured skill invocation sent to ${to} in interactive mode. The request was sent immediately; do not wait or poll get_inbox in this same turn. Any follow-up replies and final results will arrive in your inbox later.`;

      ctx.suppressInboxPollingThisTurn = true;
      return {
        content: [{ type: "text" as const, text: responseText }],
        details: {
          messageId: sent.id,
          status: s.messageBus.getStatus(),
          type: sent.type,
          skillInvocation: sent.skillInvocation,
          queued,
        },
      };
    },
  };
}

function createRequestApprovalTool(ctx: ToolContext) {
  return {
    name: "request_approval_from_agent",
    label: "Request Approval from Agent",
    description: "Send a structured approval request to another agent and track it locally until the first approval or rejection arrives.",
    promptGuidelines: [
      "Use request_approval_from_agent when delegated work needs approval from another pip2p agent.",
      "After request_approval_from_agent returns, do not wait or poll get_inbox in the same turn unless the user explicitly asks you to check immediately.",
    ],
    parameters: Type.Object({
      to: Type.String({ description: "Approver agent name" }),
      actionType: Type.String({ description: "Action category needing approval" }),
      title: Type.String({ description: "Short approval title" }),
      summary: Type.String({ description: "Short summary of what is being approved" }),
      details: Type.Optional(Type.String({ description: "Longer approval context" })),
      commands: Type.Optional(Type.Array(Type.String({ description: "Command to approve" }))),
      files: Type.Optional(Type.Array(Type.String({ description: "Affected file" }))),
      threadId: Type.Optional(Type.String({ description: "Optional workflow thread id" })),
    }),
    async execute(_toolCallId: string, params: unknown) {
      const s = getState(ctx);
      const record = getObjectParam(params);
      const to = getStringParam(record, "to");
      const actionType = getStringParam(record, "actionType");
      const title = getStringParam(record, "title");
      const summary = getStringParam(record, "summary");
      const details = getStringParam(record, "details");
      const commands = getStringArrayParam(record, "commands");
      const files = getStringArrayParam(record, "files");
      const threadId = getStringParam(record, "threadId");

      if (!to || !actionType || !title || !summary) {
        return {
          content: [{ type: "text" as const, text: 'The fields "to", "actionType", "title", and "summary" are required.' }],
          details: { error: "invalid_arguments" },
        };
      }

      const otherAgents = getOtherAgents(s.cwd, s.agentName);
      const target = otherAgents.find((a) => a.name === to);
      if (!target) {
        const available = otherAgents.map((a) => a.name).join(", ") || "none";
        return {
          content: [{ type: "text" as const, text: `Agent "${to}" not found. Available agents: ${available}` }],
          details: { error: "agent_not_found" },
        };
      }

      const unavailableTarget = getUnavailableLiveTargetResult(s, to);
      if (unavailableTarget) return unavailableTarget;

      const effectiveThreadId = threadId ?? getActiveThreadId(ctx) ?? crypto.randomUUID();

      const request: ApprovalRequest = {
        requestId: crypto.randomUUID(),
        threadId: effectiveThreadId,
        actionType,
        title,
        summary,
        details,
        commands,
        files,
        requestedAt: Date.now(),
      };

      ctx.pendingApprovals.set(request.requestId, {
        requester: to,
        request,
        status: "pending",
      });

      const sent = s.messageBus.sendMessage(to, `${title}\n\n${summary}`, "approval-request", {
        invokeThreadId: effectiveThreadId,
        approvalRequest: request,
        threadId: effectiveThreadId,
      });

      const queued = s.messageBus.isMessageQueued(sent.id);
      ctx.suppressInboxPollingThisTurn = true;
      return {
        content: [{ type: "text" as const, text: queued
          ? `Approval request queued for ${to} until the agent is idle. Request ID: ${request.requestId}`
          : `Approval request sent to ${to}. Request ID: ${request.requestId}` }],
        details: { messageId: sent.id, requestId: request.requestId, status: s.messageBus.getStatus(), approvalRequest: request, queued },
      };
    },
  };
}

function createRespondToApprovalTool(ctx: ToolContext) {
  return {
    name: "respond_to_approval_request",
    label: "Respond to Approval Request",
    description: "Send an approval or rejection decision for a structured approval request.",
    promptGuidelines: [
      "Use respond_to_approval_request to approve or reject a structured approval request from another pip2p agent.",
      "After respond_to_approval_request returns, do not wait for another reply in the same turn.",
    ],
    parameters: Type.Object({
      to: Type.String({ description: "Target agent name" }),
      requestId: Type.String({ description: "Approval request ID" }),
      decision: Type.Union([Type.Literal("approved"), Type.Literal("rejected")], {
        description: "Approval decision",
      }),
      note: Type.Optional(Type.String({ description: "Optional decision note" })),
    }),
    async execute(_toolCallId: string, params: unknown) {
      const s = getState(ctx);
      const record = getObjectParam(params);
      const to = getStringParam(record, "to");
      const requestId = getStringParam(record, "requestId");
      const decision = getApprovalDecisionParam(record);
      const note = getStringParam(record, "note");

      if (!to || !requestId || !decision) {
        return {
          content: [{ type: "text" as const, text: 'The fields "to", "requestId", and "decision" are required.' }],
          details: { error: "invalid_arguments" },
        };
      }

      const otherAgents = getOtherAgents(s.cwd, s.agentName);
      const target = otherAgents.find((a) => a.name === to);
      if (!target) {
        const available = otherAgents.map((a) => a.name).join(", ") || "none";
        return {
          content: [{ type: "text" as const, text: `Agent "${to}" not found. Available agents: ${available}` }],
          details: { error: "agent_not_found" },
        };
      }

      const unavailableTarget = getUnavailableLiveTargetResult(s, to);
      if (unavailableTarget) return unavailableTarget;

      const approvalDecision: ApprovalDecision = {
        requestId,
        decision,
        note,
        decidedAt: Date.now(),
      };

      const sent = s.messageBus.sendMessage(to, `Approval ${decision} for request ${requestId}${note ? `: ${note}` : ""}`, "approval-decision", {
        approvalDecision,
      });

      ctx.suppressInboxPollingThisTurn = true;
      return {
        content: [{ type: "text" as const, text: `Approval decision sent to ${to} for request ${requestId}.` }],
        details: { messageId: sent.id, requestId, decision, status: s.messageBus.getStatus() },
      };
    },
  };
}

function createResolveLocalApprovalTool(ctx: ToolContext) {
  return {
    name: "resolve_local_approval",
    label: "Resolve Local Approval",
    description: "Resolve a locally pending approval request from the current agent session. First valid approval wins.",
    promptGuidelines: [
      "Use resolve_local_approval when the local user approves or rejects a pending approval request that was already sent to another pip2p agent.",
      "After resolve_local_approval returns, do not wait or poll get_inbox in the same turn unless explicitly asked.",
    ],
    parameters: Type.Object({
      requestId: Type.String({ description: "Approval request ID" }),
      decision: Type.Union([Type.Literal("approved"), Type.Literal("rejected")], {
        description: "Local approval decision",
      }),
      note: Type.Optional(Type.String({ description: "Optional local decision note" })),
    }),
    async execute(_toolCallId: string, params: unknown) {
      const record = getObjectParam(params);
      const requestId = getStringParam(record, "requestId");
      const decision = getApprovalDecisionParam(record);
      const note = getStringParam(record, "note");

      if (!requestId || !decision) {
        return {
          content: [{ type: "text" as const, text: 'The fields "requestId" and "decision" are required.' }],
          details: { error: "invalid_arguments" },
        };
      }

      const pending = ctx.pendingApprovals.get(requestId);
      if (!pending) {
        return {
          content: [{ type: "text" as const, text: `No pending approval request found for ${requestId}.` }],
          details: { error: "request_not_found" },
        };
      }

      if (pending.status !== "pending") {
        return {
          content: [{ type: "text" as const, text: `Approval request ${requestId} is already resolved (${pending.status}).` }],
          details: { requestId, status: pending.status },
        };
      }

      pending.status = decision === "approved" ? "resolved-local" : "rejected";
      pending.winner = "local-user";
      pending.decision = decision;
      pending.note = note;
      pending.resolvedAt = Date.now();
      ctx.pendingApprovals.set(requestId, pending);

      ctx.suppressInboxPollingThisTurn = true;
      return {
        content: [{ type: "text" as const, text: `Local approval recorded for ${requestId}: ${decision}.` }],
        details: { requestId, status: pending.status, winner: pending.winner, decision },
      };
    },
  };
}

function createGetInboxTool(ctx: ToolContext) {
  return {
    name: "get_inbox",
    label: "Get Inbox",
    description: "Get unread messages from your inbox",
    promptGuidelines: [
      "Use get_inbox to read messages that have already arrived from other pip2p agents.",
      "Do not use get_inbox immediately after send_to_agent, reply_to_agent, invoke_skill_on_agent, or request_approval_from_agent in the same turn unless the user explicitly asks you to check messages immediately.",
    ],
    parameters: Type.Object({
      from: Type.Optional(Type.String({ description: "Filter by sender agent name" })),
    }),
    async execute(_toolCallId: string, params: unknown) {
      const s = getState(ctx);
      if (ctx.suppressInboxPollingThisTurn && !userExplicitlyAskedToCheckInbox(ctx.currentPrompt)) {
        return {
          content: [{ type: "text" as const, text: "Do not call get_inbox in the same turn right after sending, invoking, or requesting approval from another agent. Finish this turn and check later, unless the user explicitly asked you to check messages immediately." }],
          details: { blocked: "same_turn_inbox_poll" },
        };
      }

      const record = getObjectParam(params);
      const from = getStringParam(record, "from");
      let messages: PipMessage[];

      if (from) {
        messages = s.widgetManager.markReadFrom(from);
      } else {
        messages = s.widgetManager.getAll();
        s.widgetManager.markAllRead();
      }

      if (messages.length === 0) {
        return {
          content: [{ type: "text" as const, text: "No unread messages." }],
          details: { count: 0 },
        };
      }

      const coordinatorName = readServerInfo(s.cwd)?.coordinator;
      const isCoordinator = coordinatorName === s.agentName;
      if (isCoordinator) {
        const threadIdsBySender = new Map<string, Set<string>>();
        for (const message of messages) {
          if (message.from === coordinatorName) continue;
          const threadId = getEffectiveThreadId(message);
          const existing = threadIdsBySender.get(message.from) ?? new Set<string>();
          existing.add(threadId);
          threadIdsBySender.set(message.from, existing);
        }

        for (const [sender, threadIds] of threadIdsBySender) {
          for (const threadId of threadIds) {
            s.messageBus.sendMessage(sender, "thread resolved", "thread-resolved", {
              threadResolution: { threadId, sender: coordinatorName },
              threadId,
            });
          }
        }
      }

      const formatted = messages.map(formatMessage).join("\n\n");
      return {
        content: [{ type: "text" as const, text: formatted }],
        details: { messages, count: messages.length },
      };
    },
  };
}

function createListAgentsTool(ctx: ToolContext) {
  return {
    name: "list_agents",
    label: "List Agents",
    description: "List all active agents in the pip2p network",
    parameters: Type.Object({}),
    async execute() {
      const s = getState(ctx);
      const liveConnections = s.messageBus
        .getLiveAgents()
        .filter((agent) => agent.name !== s.agentName)
        .sort((a, b) => Number(b.isCoordinator) - Number(a.isCoordinator));

      if (liveConnections.length === 0) {
        return {
          content: [{ type: "text" as const, text: "No other live connections." }],
          details: { agents: [], liveConnections: [], status: s.messageBus.getStatus() },
        };
      }

      const formatAgent = (agent: AgentInfo) => `${agent.name}${agent.isCoordinator ? " (coordinator 👑)" : ""}`;
      const lines: string[] = [`You are: ${s.agentName}`, "Live connections:"];
      for (const agent of liveConnections) lines.push(`  - ${formatAgent(agent)}`);
      lines.push(`\nConnection: ${s.messageBus.getStatus() === "live" ? "🟢 Live" : "🟡 File Mode"}`);

      return {
        content: [{ type: "text" as const, text: lines.join("\n") }],
        details: { agents: liveConnections, liveConnections, status: s.messageBus.getStatus() },
      };
    },
  };
}

function createReplyToAgentTool(ctx: ToolContext) {
  return {
    name: "reply_to_agent",
    label: "Reply to Agent",
    description: "Reply to a message from another agent",
    promptGuidelines: [
      "Use reply_to_agent for an explicit progress, clarification, approval, or early-completion reply to a pip2p message; ordinary delegated final results are completion-gated until the turn settles.",
      "After reply_to_agent returns, stop and do not wait for another agent's reply in the same turn.",
      "After reply_to_agent returns, do not call get_inbox in the same turn unless the user explicitly asks you to check messages immediately.",
    ],
    parameters: Type.Object({
      to: Type.String({ description: "Agent to reply to" }),
      message: Type.String({ description: "Reply message" }),
      inReplyTo: Type.Optional(Type.String({ description: "Message ID being replied to" })),
    }),
    async execute(_toolCallId: string, params: unknown) {
      const s = getState(ctx);
      const record = getObjectParam(params);
      const to = getStringParam(record, "to");
      const message = getStringParam(record, "message");
      const inReplyTo = getStringParam(record, "inReplyTo");

      if (!to || !message) {
        return {
          content: [{ type: "text" as const, text: 'Both "to" and "message" are required.' }],
          details: { error: "invalid_arguments" },
        };
      }

      const otherAgents = getOtherAgents(s.cwd, s.agentName);
      const target = otherAgents.find((a) => a.name === to);
      if (!target) {
        const available = otherAgents.map((a) => a.name).join(", ") || "none";
        return {
          content: [{ type: "text" as const, text: `Agent "${to}" not found. Available agents: ${available}` }],
          details: { error: "agent_not_found" },
        };
      }

      const unavailableTarget = getUnavailableLiveTargetResult(s, to);
      if (unavailableTarget) return unavailableTarget;

      const threadId = getActiveThreadId(ctx) ?? inReplyTo ?? crypto.randomUUID();
      const sent = s.messageBus.sendMessage(to, message, "response", { inReplyTo, threadId });
      ctx.suppressInboxPollingThisTurn = true;
      return {
        content: [{ type: "text" as const, text: `Reply sent to ${to} (${s.messageBus.getStatus()} mode)` }],
        details: { messageId: sent.id, status: s.messageBus.getStatus() },
      };
    },
  };
}
