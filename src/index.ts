/**
 * pip2p - Pi-to-Pi Multi-Agent Communication Extension
 *
 * Entry point for the pi extension.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { MessageBus } from "./message-bus.js";
import { WidgetManager } from "./widget-manager.js";
import {
  ensurePip2pDirs,
  ensureGitignore,
  ensureAgentInbox,
  addAgent,
  removeAgent,
  readServerInfo,
  writeServerInfo,
  removeServerInfo,
  isCoordinatorAlive,
  getCoordinator,
} from "./agent-registry.js";
import { PipServer } from "./server.js";
import { createTools } from "./tools.js";
import type { ConnectionStatus } from "./types.js";

export default function (pi: ExtensionAPI) {
  let messageBus: MessageBus | null = null;
  let widgetManager: WidgetManager | null = null;
  let agentName: string | null = null;
  let connectionStatus: ConnectionStatus = "file";
  let server: PipServer | null = null;

  // Initialize on session start
  pi.on("session_start", async (_event, ctx) => {
    // Prompt user for agent name
    if (!ctx.hasUI) return;
    
    const name = await ctx.ui.input("Agent name", "Enter your agent name (e.g., alice, bob):");
    if (!name) return;
    
    agentName = name;

    const cwd = ctx.cwd;

    // Ensure directory structure
    const isNew = ensurePip2pDirs(cwd);
    ensureAgentInbox(cwd, agentName);

    // If .pip2p was newly created, add to .gitignore
    if (isNew) {
      ensureGitignore(cwd);
    }

    // Initialize widget manager
    widgetManager = new WidgetManager(agentName, cwd, ctx);

    // Sync inbox from disk (pick up any messages received while offline)
    widgetManager.syncFromDisk();

    // Initialize message bus
    messageBus = new MessageBus(agentName, cwd);

    // Handle incoming messages
    messageBus.onMessage((msg) => {
      console.log(`[pip2p] Received message from ${msg.from}, type: ${msg.type}`);
      
      if (msg.type !== "response") {
        // Task and message types auto-inject so agent processes them
        const instruction = `[pip2p] ${msg.from} sent you a ${msg.type}: "${msg.content}"\nIMPORTANT: You MUST use the send_to_agent or reply_to_agent tool to send your response back to ${msg.from}. Do NOT just reply in this conversation — ${msg.from} cannot see your responses here. The message content is already provided above — you do NOT need to call get_inbox.`;
        
        pi.sendUserMessage(instruction, { deliverAs: "followUp" });
      } else {
        // Response messages go to inbox widget only
        widgetManager?.addMessage(msg);
      }
    });

    // Handle status changes
    messageBus.onStatusChange((status: ConnectionStatus) => {
      connectionStatus = status;
      widgetManager?.updateAgentsWidget(status);
    });

    // Determine role and initialize
    const role = await messageBus.init();

    // If coordinator, set up agent join/leave callbacks
    if (role === "coordinator" && messageBus.getServer()) {
      messageBus.getServer()!.onAgentJoin((agent) => {
        // Update widget when a new agent joins
        widgetManager?.updateAgentsWidget(connectionStatus);
      });
      messageBus.getServer()!.onAgentLeave((agentName) => {
        // Update widget when an agent leaves
        widgetManager?.updateAgentsWidget(connectionStatus);
      });
    }

    // Register agent
    addAgent(cwd, {
      name: agentName,
      pid: process.pid,
      startedAt: Date.now(),
      isCoordinator: role === "coordinator",
      cwd,
    });

    // Update widgets
    connectionStatus = messageBus.getStatus();
    widgetManager.updateAgentsWidget(connectionStatus);

    // Register tools with pi
    const tools = createTools({
      agentName,
      cwd,
      messageBus,
      widgetManager,
    });

    for (const tool of tools) {
      pi.registerTool(tool as any);
    }

    ctx.ui.notify(
      `pip2p: ${agentName} joined as ${role} (${connectionStatus} mode)`,
      "info",
    );
  });

  // Cleanup on shutdown
  pi.on("session_shutdown", async (_event, _ctx) => {
    if (agentName) {
      // Remove agent from registry
      removeAgent(_ctx.cwd, agentName);

      // If we're the coordinator, clean up server info
      const coordinator = getCoordinator(_ctx.cwd);
      if (coordinator?.name === agentName) {
        removeServerInfo(_ctx.cwd);
      }
    }

    // Shutdown message bus
    messageBus?.shutdown();

    // Hide widgets
    widgetManager?.hideAll();
  });
}
