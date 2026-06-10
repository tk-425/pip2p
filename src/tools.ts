/**
 * Custom Tools - pip2p tools for agent communication
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { Type } from "@sinclair/typebox";
import { getInboxDir, getOtherAgents, readAgentRegistry } from "./agent-registry.js";
import { formatMessage, detectSkillReference } from "./skill-detect.js";
import type { MessageBus } from "./message-bus.js";
import type { WidgetManager } from "./widget-manager.js";
import type { PipMessage, MessageType } from "./types.js";

interface ToolContext {
  agentName: string;
  cwd: string;
  messageBus: MessageBus;
  widgetManager: WidgetManager;
}

interface ToolDefinition {
  name: string;
  label: string;
  description: string;
  promptSnippet?: string;
  parameters: object;
  execute: (
    toolCallId: string,
    params: any,
    signal: AbortSignal | undefined,
    onUpdate: ((result: any) => void) | undefined,
    ctx: any,
  ) => Promise<{ content: Array<{ type: string; text: string }>; details: Record<string, unknown> }>;
}

/**
 * Create all pip2p tools
 */
export function createTools(toolCtx: ToolContext): ToolDefinition[] {
  return [
    createSendToAgentTool(toolCtx),
    createGetInboxTool(toolCtx),
    createListAgentsTool(toolCtx),
    createReplyToAgentTool(toolCtx),
  ];
}

function createSendToAgentTool(ctx: ToolContext): ToolDefinition {
  return {
    name: "send_to_agent",
    label: "Send to Agent",
    description: "Send a task or message to another agent in the pip2p network",
    promptSnippet: "Send a message or task to another agent by name",
    parameters: Type.Object({
      to: Type.String({ description: "Target agent name" }),
      message: Type.String({ description: "Message or task description" }),
      type: Type.Optional(
        Type.Union([Type.Literal("task"), Type.Literal("message")], {
          default: "task",
        }),
      ),
    }),
    async execute(_toolCallId, params) {
      const { to, message, type = "task" } = params;

      // Validate target agent exists
      const otherAgents = getOtherAgents(ctx.cwd, ctx.agentName);
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

      // Smart reply detection: if target recently sent us a message, treat this as a response
      let finalType: MessageType = type;
      let finalInReplyTo: string | undefined;
      const recentFromTarget = ctx.messageBus.hasRecentFrom(to);
      console.log(`[pip2p:safeguard] send_to_agent: to=${to}, type=${type}, hasRecent=${!!recentFromTarget}, recentId=${recentFromTarget?.id ?? 'null'}`);
      if (recentFromTarget && type !== "response") {
        finalType = "response";
        finalInReplyTo = recentFromTarget.id;
        console.log(`[pip2p:safeguard] CONVERTED to response, inReplyTo=${finalInReplyTo}`);
      } else {
        console.log(`[pip2p:safeguard] NOT converted. recentFromTarget=${!!recentFromTarget}, type=${type}`);
      }

      const sent = ctx.messageBus.sendMessage(to, message, finalType, finalInReplyTo);

      let responseText = `Message sent to ${to} (${ctx.messageBus.getStatus()} mode)`;
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
        details: { messageId: sent.id, status: ctx.messageBus.getStatus(), type: finalType },
      };
    },
  };
}

function createGetInboxTool(ctx: ToolContext): ToolDefinition {
  return {
    name: "get_inbox",
    label: "Get Inbox",
    description: "Get unread messages from your inbox",
    promptSnippet: "Retrieve and read unread messages from other agents",
    parameters: Type.Object({
      from: Type.Optional(
        Type.String({ description: "Filter by sender agent name" }),
      ),
    }),
    async execute(_toolCallId, params) {
      const { from } = params;

      let messages: PipMessage[];

      if (from) {
        messages = ctx.widgetManager.markReadFrom(from);
      } else {
        messages = ctx.widgetManager.getAll();
        ctx.widgetManager.markAllRead();
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

function createListAgentsTool(ctx: ToolContext): ToolDefinition {
  return {
    name: "list_agents",
    label: "List Agents",
    description: "List all active agents in the pip2p network",
    promptSnippet: "Show all active agents in the network",
    parameters: Type.Object({}),
    async execute() {
      const otherAgents = getOtherAgents(ctx.cwd, ctx.agentName);

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

      const lines: string[] = [`You are: ${ctx.agentName}`, "Other agents:"];
      for (const agent of otherAgents) {
        const role = agent.isCoordinator ? " (coordinator 👑)" : "";
        lines.push(`  - ${agent.name}${role}`);
      }
      lines.push(`\nConnection: ${ctx.messageBus.getStatus() === "live" ? "🟢 Live" : "🟡 File Mode"}`);

      return {
        content: [{ type: "text" as const, text: lines.join("\n") }],
        details: { agents: otherAgents, status: ctx.messageBus.getStatus() },
      };
    },
  };
}

function createReplyToAgentTool(ctx: ToolContext): ToolDefinition {
  return {
    name: "reply_to_agent",
    label: "Reply to Agent",
    description: "Reply to a message from another agent",
    promptSnippet: "Reply to a specific message from another agent",
    parameters: Type.Object({
      to: Type.String({ description: "Agent to reply to" }),
      message: Type.String({ description: "Reply message" }),
      inReplyTo: Type.Optional(
        Type.String({ description: "Message ID being replied to" }),
      ),
    }),
    async execute(_toolCallId, params) {
      const { to, message, inReplyTo } = params;

      // Validate target agent exists
      const otherAgents = getOtherAgents(ctx.cwd, ctx.agentName);
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

      const sent = ctx.messageBus.sendMessage(to, message, "response", inReplyTo);

      return {
        content: [
          {
            type: "text" as const,
            text: `Reply sent to ${to} (${ctx.messageBus.getStatus()} mode)`,
          },
        ],
        details: { messageId: sent.id, status: ctx.messageBus.getStatus() },
      };
    },
  };
}
