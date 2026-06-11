/**
 * Custom Tools - pip2p tools for agent communication
 */

import { Type } from "@sinclair/typebox";
import { getOtherAgents } from "./agent-registry.js";
import { formatMessage } from "./skill-detect.js";
import type { MessageBus } from "./message-bus.js";
import type { WidgetManager } from "./widget-manager.js";
import type { PipMessage, MessageType } from "./types.js";

export interface ToolContext {
  agentName: string | null;
  cwd: string;
  messageBus: MessageBus | null;
  widgetManager: WidgetManager | null;
}

type ReadyToolContext = {
  [K in keyof ToolContext]: NonNullable<ToolContext[K]>;
};

function getState(ctx: ToolContext): ReadyToolContext {
  if (!ctx.agentName || !ctx.messageBus || !ctx.widgetManager) {
    throw new Error("pip2p: not initialized — wait for session to start before using pip2p tools");
  }
  return ctx as ReadyToolContext;
}

/**
 * Create all pip2p tools
 */
export function createTools(toolCtx: ToolContext) {
  return [
    createSendToAgentTool(toolCtx),
    createInvokeSkillTool(toolCtx),
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
    parameters: Type.Object({
      to: Type.String({ description: "Target agent name" }),
      message: Type.String({ description: "Message or task description" }),
      type: Type.Optional(
        Type.Union([Type.Literal("task"), Type.Literal("message")], {
          default: "task",
        }),
      ),
    }),
    async execute(_toolCallId: string, params: any) {
      const s = getState(ctx);
      const { to, message, type = "task" } = params;

      // Validate target agent exists
      const otherAgents = getOtherAgents(s.cwd, s.agentName);
      const target = otherAgents.find((a) => a.name === to);
      if (!target) {
        const available = otherAgents.map((a) => a.name).join(", ") || "none";
        return {
          content: [
            {
              type: "text" as const,
              text: `Agent "${to}" not found. Available agents: ${available}`,
            },
          ],
          details: { error: "agent_not_found" },
        };
      }

      let finalType: MessageType = type;
      let finalInReplyTo: string | undefined;
      let finalInvokeThreadId: string | undefined;
      const recentFromTarget = s.messageBus.hasRecentFrom(to);
      if (recentFromTarget && type !== "response") {
        if (recentFromTarget.type === "task" || recentFromTarget.type === "message" || recentFromTarget.type === "invoke-skill") {
          finalType = "response";
          finalInReplyTo = recentFromTarget.id;
        } else if (recentFromTarget.type === "response" && recentFromTarget.invokeThreadId) {
          finalType = "response";
          finalInReplyTo = recentFromTarget.id;
          finalInvokeThreadId = recentFromTarget.invokeThreadId;
        }
      }

      const sent = s.messageBus.sendMessage(to, message, finalType, finalInReplyTo, undefined, finalInvokeThreadId);

      let responseText = `Message sent to ${to} (${s.messageBus.getStatus()} mode)`;
      if (finalType === "response" && type !== "response") {
        responseText += `\nNote: Auto-detected as response to ${to}'s recent message (prevents auto-loop)`;
      }

      return {
        content: [
          {
            type: "text" as const,
            text: responseText,
          },
        ],
        details: { messageId: sent.id, status: s.messageBus.getStatus(), type: finalType },
      };
    },
  };
}

function createInvokeSkillTool(ctx: ToolContext) {
  return {
    name: "invoke_skill_on_agent",
    label: "Invoke Skill on Agent",
    description: "Send a structured skill invocation request to another agent. Defaults to interactive mode unless replyMode is explicitly set to auto.",
    parameters: Type.Object({
      to: Type.String({ description: "Target agent name" }),
      skill: Type.String({ description: "Local skill name to invoke on the target agent" }),
      args: Type.Optional(Type.String({ description: "Arguments to append after the skill command" })),
      replyMode: Type.Optional(
        Type.Union([Type.Literal("auto"), Type.Literal("interactive")], {
          description: "Reply behavior: auto forwards the final result, interactive allows follow-up questions and manual continuation. Defaults to interactive.",
        }),
      ),
    }),
    async execute(_toolCallId: string, params: any) {
      const { to, skill, args, replyMode = "interactive" } = params;
      const s = getState(ctx);

      const otherAgents = getOtherAgents(s.cwd, s.agentName);
      const target = otherAgents.find((a) => a.name === to);
      if (!target) {
        const available = otherAgents.map((a) => a.name).join(", ") || "none";
        return {
          content: [
            {
              type: "text" as const,
              text: `Agent "${to}" not found. Available agents: ${available}`,
            },
          ],
          details: { error: "agent_not_found" },
        };
      }

      const sent = s.messageBus.sendMessage(
        to,
        "Structured skill invocation request",
        "invoke-skill",
        undefined,
        {
          skillName: skill,
          args,
          replyMode,
        },
      );

      const responseText =
        replyMode === "auto"
          ? `Structured skill invocation sent to ${to} in auto mode. The final result will arrive in your inbox when complete — do NOT poll get_inbox. Stop and wait for the user to ask for results.`
          : `Structured skill invocation sent to ${to} in interactive mode. The target agent may ask follow-up questions or continue the interaction manually; wait for the user to ask before checking get_inbox.`;

      return {
        content: [
          {
            type: "text" as const,
            text: responseText,
          },
        ],
        details: {
          messageId: sent.id,
          status: s.messageBus.getStatus(),
          type: sent.type,
          skillInvocation: sent.skillInvocation,
        },
      };
    },
  };
}

function createGetInboxTool(ctx: ToolContext) {
  return {
    name: "get_inbox",
    label: "Get Inbox",
    description: "Get unread messages from your inbox",
    parameters: Type.Object({
      from: Type.Optional(
        Type.String({ description: "Filter by sender agent name" }),
      ),
    }),
    async execute(_toolCallId: string, params: any) {
      const s = getState(ctx);
      const { from } = params;

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
      const otherAgents = getOtherAgents(s.cwd, s.agentName);

      if (otherAgents.length === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: "No other agents in the network. You are the only agent.",
            },
          ],
          details: { agents: [] },
        };
      }

      const lines: string[] = [`You are: ${s.agentName}`, "Other agents:"];
      for (const agent of otherAgents) {
        const role = agent.isCoordinator ? " (coordinator 👑)" : "";
        lines.push(`  - ${agent.name}${role}`);
      }
      lines.push(`\nConnection: ${s.messageBus.getStatus() === "live" ? "🟢 Live" : "🟡 File Mode"}`);

      return {
        content: [{ type: "text" as const, text: lines.join("\n") }],
        details: { agents: otherAgents, status: s.messageBus.getStatus() },
      };
    },
  };
}

function createReplyToAgentTool(ctx: ToolContext) {
  return {
    name: "reply_to_agent",
    label: "Reply to Agent",
    description: "Reply to a message from another agent",
    parameters: Type.Object({
      to: Type.String({ description: "Agent to reply to" }),
      message: Type.String({ description: "Reply message" }),
      inReplyTo: Type.Optional(
        Type.String({ description: "Message ID being replied to" }),
      ),
    }),
    async execute(_toolCallId: string, params: any) {
      const s = getState(ctx);
      const { to, message, inReplyTo } = params;

      // Validate target agent exists
      const otherAgents = getOtherAgents(s.cwd, s.agentName);
      const target = otherAgents.find((a) => a.name === to);
      if (!target) {
        const available = otherAgents.map((a) => a.name).join(", ") || "none";
        return {
          content: [
            {
              type: "text" as const,
              text: `Agent "${to}" not found. Available agents: ${available}`,
            },
          ],
          details: { error: "agent_not_found" },
        };
      }

      const sent = s.messageBus.sendMessage(to, message, "response", inReplyTo);

      return {
        content: [
          {
            type: "text" as const,
            text: `Reply sent to ${to} (${s.messageBus.getStatus()} mode)`,
          },
        ],
        details: { messageId: sent.id, status: s.messageBus.getStatus() },
      };
    },
  };
}
