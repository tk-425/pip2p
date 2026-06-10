/**
 * pip2p - Peer-to-Peer Multi-Agent Communication Extension
 *
 * Compatible with pi and oh-my-pi (omp).
 */

import type { ExtensionAPI, BeforeAgentStartEvent, BeforeAgentStartEventResult } from "@earendil-works/pi-coding-agent";
import { MessageBus } from "./message-bus.js";
import { WidgetManager } from "./widget-manager.js";
import {
  ensurePip2pDirs,
  ensureGitignore,
  ensureAgentInbox,
  addAgent,
  removeAgent,
  removeServerInfo,
  getCoordinator,
} from "./agent-registry.js";
import { createTools, type ToolContext } from "./tools.js";
import type { ConnectionStatus } from "./types.js";


function buildIdentityBlock(agentName: string): string {
  return `## pip2p Agent

This agent is registered as **${agentName}** on the pip2p network.

Available peer communication tools:
- **send_to_agent** — Send a task or message to another agent by name
- **get_inbox** — Retrieve messages from your inbox (optionally filter by sender)
- **reply_to_agent** — Reply to a specific message with threading support
- **list_agents** — Show all active agents and their connection status

When the user asks you to send a message to another agent, use the **send_to_agent** tool. Do NOT read source files or try to understand the messaging system — the tools are already available.`;
}
export default function (pi: ExtensionAPI) {
  let connectionStatus: ConnectionStatus = "file";

  // Mutable context shared with tools — registered at factory time,
  // populated in session_start so omp builds its active tool set correctly.
  const toolCtx: ToolContext = {
    agentName: null,
    cwd: "",
    messageBus: null,
    widgetManager: null,
  };

  // Register tools immediately so omp/pi includes them in the active tool set
  const tools = createTools(toolCtx);
  for (const tool of tools) {
    pi.registerTool(tool as any);
  }

  // Initialize on session start
  pi.on("session_start", async (_event, ctx) => {
    if (!ctx.hasUI) return;

    const name = await ctx.ui.input("Agent name", "Enter your agent name (e.g., alice, bob):");
    if (!name?.trim()) return;

    toolCtx.agentName = name.trim();
    toolCtx.cwd = ctx.cwd;

    const cwd = toolCtx.cwd;

    // Ensure directory structure
    const isNew = ensurePip2pDirs(cwd);
    ensureAgentInbox(cwd, toolCtx.agentName!);

    // If .pip2p was newly created, add to .gitignore
    if (isNew) {
      ensureGitignore(cwd);
    }

    // Initialize widget manager
    toolCtx.widgetManager = new WidgetManager(toolCtx.agentName!, cwd, ctx);

    // Sync inbox from disk (pick up any messages received while offline)
    toolCtx.widgetManager.syncFromDisk();

    // Initialize message bus
    toolCtx.messageBus = new MessageBus(toolCtx.agentName!, cwd);

    // Handle incoming messages
    toolCtx.messageBus.onMessage((msg) => {
      console.log(`[pip2p] Received message from ${msg.from}, type: ${msg.type}`);
      
      if (msg.type !== "response") {
        // Task and message types auto-inject so agent processes them
        const instruction = `[pip2p] ${msg.from} sent you a ${msg.type}: "${msg.content}"\nIMPORTANT:\n1. First, work out your response and SHOW it to your user so they can see what you're sending.\n2. Then use send_to_agent or reply_to_agent to send your response back to ${msg.from}. Do NOT just reply in this conversation — ${msg.from} cannot see your responses here.\nThe message content is already provided above — you do NOT need to call get_inbox.`;
        
        pi.sendUserMessage(instruction);
      } else {
        // Response messages go to inbox widget only
        toolCtx.widgetManager?.addMessage(msg);
      }
    });

    // Handle status changes
    toolCtx.messageBus.onStatusChange((status: ConnectionStatus) => {
      connectionStatus = status;
      toolCtx.widgetManager?.updateAgentsWidget(status);
    });

    // Determine role and initialize
    const role = await toolCtx.messageBus.init();

    // If coordinator, set up agent join/leave callbacks
    if (role === "coordinator" && toolCtx.messageBus.getServer()) {
      toolCtx.messageBus.getServer()!.onAgentJoin((agent) => {
        toolCtx.widgetManager?.updateAgentsWidget(connectionStatus);
      });
      toolCtx.messageBus.getServer()!.onAgentLeave((agentName) => {
        toolCtx.widgetManager?.updateAgentsWidget(connectionStatus);
      });
    }

    // Register agent
    addAgent(cwd, {
      name: toolCtx.agentName!,
      pid: process.pid,
      startedAt: Date.now(),
      isCoordinator: role === "coordinator",
      cwd,
    });

    // Update widgets
    connectionStatus = toolCtx.messageBus.getStatus();
    toolCtx.widgetManager!.updateAgentsWidget(connectionStatus);



    // Inject identity block into system prompt
    pi.on("before_agent_start", (event: BeforeAgentStartEvent): BeforeAgentStartEventResult => {
      return { systemPrompt: event.systemPrompt + "\n\n" + buildIdentityBlock(toolCtx.agentName!) };
    });

    ctx.ui.notify(
      `pip2p: ${toolCtx.agentName} joined as ${role} (${connectionStatus} mode)`,
      "info",
    );
  });

  // Cleanup on shutdown
  pi.on("session_shutdown", async (_event, _ctx) => {
    if (toolCtx.agentName) {
      removeAgent(_ctx.cwd, toolCtx.agentName);

      const coordinator = getCoordinator(_ctx.cwd);
      if (coordinator?.name === toolCtx.agentName) {
        removeServerInfo(_ctx.cwd);
      }
    }

    toolCtx.messageBus?.shutdown();

    // Hide widgets
    toolCtx.widgetManager?.hideAll();
  });
}
