/**
 * pip2p - Peer-to-Peer Multi-Agent Communication Extension
 *
 * Compatible with pi and oh-my-pi (omp).
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ExtensionAPI, BeforeAgentStartEvent, BeforeAgentStartEventResult, SessionStartEvent, SessionShutdownEvent } from "@earendil-works/pi-coding-agent";
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
  getAgentByPid,
  readServerInfo,
} from "./agent-registry.js";
import { createTools, type ToolContext } from "./tools.js";
import type { ApprovalDecision, ConnectionStatus, PendingApprovalEntry } from "./types.js";
import { detectSkillReference } from "./skill-detect.js";

function buildSkillCommand(
  pi: ExtensionAPI,
  skillName: string,
  args: string | undefined,
): { ok: true; command: string } | { ok: false; error: string } {
  const slashCommands = pi.getCommands();
  const skillCommand = slashCommands.find(
    (command) => command.source === "skill" && (command.name === `skill:${skillName}` || command.name === skillName),
  );

  if (!skillCommand) {
    return { ok: false, error: `skill "${skillName}" is not available in this session` };
  }

  const command = args ? `/skill:${skillName} ${args}` : `/skill:${skillName}`;
  return { ok: true, command };
}
function buildDelegatedRunPreamble(invokerName: string): string {
  return `[pip2p delegated run]

This skill was invoked by pip2p agent ${invokerName}.
Treat ${invokerName} as the coordinating invoker for this delegated run.

Rules:
- If you need approval, send a structured approval request to ${invokerName} with request_approval_from_agent.
- After sending request_approval_from_agent, do not wait on irc for ${invokerName}. Approval decisions arrive through the structured approval protocol and resolve directly in your session.
- For replies, clarifications, progress updates, and final results back to ${invokerName}, use reply_to_agent so the message goes to ${invokerName}'s inbox.
- Do not use send_to_agent task mode to return delegated skill results to ${invokerName}.
- Do not rely only on the local user for delegated approval flow.
- If the local user resolves approval first, use resolve_local_approval, but continue treating ${invokerName} as part of the delegated workflow.`;
}
function isOmpRuntime(): boolean {
  return Boolean(process.versions?.bun) || process.title === "omp";
}

async function buildOmpSkillPrompt(
  cwd: string,
  invokerName: string,
  skillName: string,
  args: string | undefined,
): Promise<
  | {
      ok: true;
      payload: {
        customType: "skill-prompt";
        content: string;
        display: true;
        details: { name: string; path: string; args?: string; lineCount: number };
        attribution: "user";
      };
    }
  | { ok: false; error: string }
> {
  const skillPath = join(cwd, ".agents", "skills", skillName, "SKILL.md");
  const trimmedArgs = args?.trim() ?? "";

  let content: string;
  try {
    content = await readFile(skillPath, "utf8");
  } catch {
    return {
      ok: false,
      error: `project-local skill "${skillName}" was not found at .agents/skills/${skillName}/SKILL.md`,
    };
  }

  const body = content.replace(/^---\n[\s\S]*?\n---\n/, "").trim();
  const metaLines = [`Skill: ${skillPath}`];
  if (trimmedArgs) {
    metaLines.push(`User: ${trimmedArgs}`);
  }

  const preamble = buildDelegatedRunPreamble(invokerName);
  const message = `${preamble}\n\n${body}\n\n---\n\n${metaLines.join("\n")}`;
  return {
    ok: true,
    payload: {
      customType: "skill-prompt",
      content: message,
      display: true,
      details: {
        name: skillName,
        path: skillPath,
        args: trimmedArgs || undefined,
        lineCount: body ? body.split("\n").length : 0,
      },
      attribution: "user",
    },
  };
}


function buildIdentityBlock(agentName: string): string {
  return `## pip2p Agent

This agent is registered as **${agentName}** on the pip2p network.

Available peer communication tools:
- **send_to_agent** — Send a task or message to another agent by name
- **invoke_skill_on_agent** — Send a structured local skill invocation request to another agent
- **request_approval_from_agent** — Send a structured approval request to another agent
- **respond_to_approval_request** — Approve or reject a structured approval request
- **resolve_local_approval** — Resolve a pending approval request from the local session
- **get_inbox** — Retrieve messages from your inbox (optionally filter by sender)
- **reply_to_agent** — Reply to a specific message with threading support
- **list_agents** — Show all active agents and their connection status

When the user asks you to send a message to another agent, use the **send_to_agent** tool.
When the user asks you to invoke a local skill on another agent, use the **invoke_skill_on_agent** tool.
When delegated work needs approval, use **request_approval_from_agent** so the coordinator can approve it too.
Do NOT read source files or try to understand the messaging system — the tools are already available.`;
}
type ActiveInvokeSession = {
  requester: string;
  requestMessageId: string;
  skillName: string;
  mode: "auto" | "interactive";
  threadId: string;
};

function extractAssistantText(message: { content?: Array<{ type?: string; text?: string }> }): string {
  const text = (message.content ?? [])
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text!.trim())
    .filter(Boolean)
    .join("\n\n")
    .trim();

  return text;
}
function resolvePendingApproval(
  pendingApprovals: Map<string, PendingApprovalEntry>,
  approvalDecision: ApprovalDecision,
  winner: PendingApprovalEntry["winner"],
): PendingApprovalEntry | null {
  const pending = pendingApprovals.get(approvalDecision.requestId);
  if (!pending || pending.status !== "pending") {
    return null;
  }

  pending.status = approvalDecision.decision === "approved" ? "resolved-remote" : "rejected";
  pending.winner = winner;
  pending.decision = approvalDecision.decision;
  pending.note = approvalDecision.note;
  pending.resolvedAt = approvalDecision.decidedAt;
  pendingApprovals.set(approvalDecision.requestId, pending);
  return pending;
}
export default function (pi: ExtensionAPI) {
  let connectionStatus: ConnectionStatus = "file";

  // Mutable context shared with tools — registered at factory time,
  // populated in session_start so omp builds its active tool set correctly.
  const pendingApprovals = new Map<string, PendingApprovalEntry>();
  const toolCtx: ToolContext = {
    agentName: null,
    cwd: "",
    messageBus: null,
    widgetManager: null,
    suppressInboxPollingThisTurn: false,
    currentPrompt: "",
    pendingApprovals,
  };

  // Register tools immediately so omp/pi includes them in the active tool set
  let activeInvokeSession: ActiveInvokeSession | null = null;

  function clearInvokeSession(): void {
    activeInvokeSession = null;
  }

  pi.on("message_end", (event) => {
    if (event.message.role !== "assistant" || !activeInvokeSession || !toolCtx.messageBus) {
      return;
    }

    if (activeInvokeSession.mode === "interactive") {
      return;
    }

    const text = extractAssistantText(event.message as { content?: Array<{ type?: string; text?: string }> });
    if (!text) {
      return;
    }

    toolCtx.messageBus.sendMessage(
      activeInvokeSession.requester,
      text,
      "response",
      activeInvokeSession.requestMessageId,
      undefined,
      activeInvokeSession.threadId,
    );

    clearInvokeSession();
  });
  const tools = createTools(toolCtx);
  for (const tool of tools) {
    pi.registerTool(tool as any);
  }

  // Reasons where the P2P network should persist across the session transition.
  // The extension is re-created by pi, so we use disk-persisted agent name to
  // reconnect seamlessly.
  const persistReasons: Set<string> = new Set(["new", "resume", "fork"]);

  // Initialize on session start
  pi.on("session_start", async (event: SessionStartEvent, ctx) => {
    if (!ctx.hasUI) return;

    // Determine agent name: on session replacement (new/resume/fork), look up
    // by PID from agents.json. After /new the process PID stays the same.
    let name: string | undefined;
    if (persistReasons.has(event.reason)) {
      const byPid = getAgentByPid(ctx.cwd, process.pid);
      if (byPid) {
        name = byPid.name;
      }
    }

    // Fallback: ask the user (first startup or if no persisted name)
    if (!name) {
      const input = await ctx.ui.input("Agent name", "Enter your agent name (e.g., alice, bob):");
      if (!input?.trim()) return;
      name = input.trim();
    }

    // Persist agent to registry for future PID-based lookup
    toolCtx.agentName = name;
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
    toolCtx.messageBus.onMessage(async (msg) => {

      if (msg.type === "invoke-skill") {
        const skillName = msg.skillInvocation?.skillName?.trim();
        const args = msg.skillInvocation?.args?.trim();

        if (!skillName) {
          toolCtx.messageBus?.sendMessage(
            msg.from,
            `Failed to invoke skill: missing or malformed skill name in invoke-skill request ${msg.id}.`,
            "response",
            msg.id,
          );
          return;
        }

        try {
          const mode = msg.skillInvocation?.replyMode === "auto" ? "auto" : "interactive";
          clearInvokeSession();
          activeInvokeSession = {
            requester: msg.from,
            requestMessageId: msg.id,
            skillName,
            mode,
            threadId: msg.id,
          };

          if (isOmpRuntime()) {
            const ompSkillResult = await buildOmpSkillPrompt(cwd, msg.from, skillName, args);
            if (!ompSkillResult.ok) {
              clearInvokeSession();
              toolCtx.messageBus?.sendMessage(
                msg.from,
                `Failed to invoke skill: ${ompSkillResult.error}`,
                "response",
                msg.id,
              );
              return;
            }

            pi.sendMessage(ompSkillResult.payload, { triggerTurn: true });
            return;
          }

          const skillResult = buildSkillCommand(pi, skillName, args);
          if (!skillResult.ok) {
            clearInvokeSession();
            toolCtx.messageBus?.sendMessage(
              msg.from,
              `Failed to invoke skill: ${skillResult.error}`,
              "response",
              msg.id,
            );
            return;
          }

          const delegatedMessage = `${buildDelegatedRunPreamble(msg.from)}\n\n${skillResult.command}`;
          pi.sendUserMessage(delegatedMessage);
        } catch (err) {
          clearInvokeSession();
          toolCtx.messageBus?.sendMessage(
            msg.from,
            `Failed to invoke skill "${skillName}": ${err instanceof Error ? err.message : String(err)}`,
            "response",
            msg.id,
          );
        }
        return;
      }

      if (msg.type === "response") {
        // Response messages go to inbox widget only
        toolCtx.widgetManager?.addMessage(msg);
        return;
      }
      if (msg.type === "approval-request") {
        toolCtx.widgetManager?.addMessage(msg);
        return;
      }

      if (msg.type === "approval-decision") {
        if (msg.approvalDecision) {
          resolvePendingApproval(pendingApprovals, msg.approvalDecision, "agent");
          const noteSuffix = msg.approvalDecision.note ? `\nNote: ${msg.approvalDecision.note}` : "";
          pi.sendUserMessage(
            `[pip2p] Approval decision received from ${msg.from} for request ${msg.approvalDecision.requestId}: ${msg.approvalDecision.decision}.${noteSuffix}\n\nContinue the delegated workflow now. Do not call get_inbox for this approval; it has already been delivered directly.`,
          );
        }
        return;
      }

      // Task and message types auto-inject so agent processes them
      let instruction = `[pip2p] ${msg.from} sent you a ${msg.type}: "${msg.content}"\n\nIMPORTANT:\n1. Work out your response and SHOW it to your user so they can see what you're sending.\n2. Use send_to_agent or reply_to_agent to send your response back to ${msg.from}. Do NOT just reply in this conversation — ${msg.from} cannot see your responses here.\n3. After sending, STOP and wait for new user input or a new message. Do NOT continue the conversation or invent follow-up requests.\n\nThe message content is already provided above — you do NOT need to call get_inbox.`;

      const skillName = detectSkillReference(msg.content);
      if (skillName) {
        instruction += `\n\nHint: ${msg.from} mentioned the "${skillName}" skill. You can invoke it with /skill:${skillName}`;
      }

      pi.sendUserMessage(instruction);
    });

    // Handle status changes
    toolCtx.messageBus.onStatusChange((status: ConnectionStatus) => {
      connectionStatus = status;
      toolCtx.widgetManager?.updateAgentsWidget(status);
    });

    // Determine role and initialize
    const role = await toolCtx.messageBus.init();

    // Listen for agent join/leave events (from the detached server)
    toolCtx.messageBus.onAgentJoin((_agent) => {
      toolCtx.widgetManager?.updateAgentsWidget(connectionStatus);
    });
    toolCtx.messageBus.onAgentLeave((_agentName) => {
      toolCtx.widgetManager?.updateAgentsWidget(connectionStatus);
    });

    // Determine coordinator status from server.json (not from init() return value)
    // so that coordinator role persists across /new session replacements.
    const serverInfo = readServerInfo(cwd);
    const isCoordinator = serverInfo?.coordinator === toolCtx.agentName;

    // Register agent
    addAgent(cwd, {
      name: toolCtx.agentName!,
      pid: process.pid,
      startedAt: Date.now(),
      isCoordinator,
      cwd,
    });

    // Update widgets
    connectionStatus = toolCtx.messageBus.getStatus();
    toolCtx.widgetManager!.updateAgentsWidget(connectionStatus);



    // Inject identity block into system prompt
    pi.on("before_agent_start", (event: BeforeAgentStartEvent): BeforeAgentStartEventResult => {
      toolCtx.currentPrompt = event.prompt;
      toolCtx.suppressInboxPollingThisTurn = false;
      if (activeInvokeSession?.mode === "interactive" && !event.prompt.startsWith("[pip2p] ")) {
        clearInvokeSession();
      }
      return { systemPrompt: event.systemPrompt + "\n\n" + buildIdentityBlock(toolCtx.agentName!) };
    });

    ctx.ui.notify(`pip2p: ${toolCtx.agentName} ${event.reason === "startup" ? "joined" : "reconnected"}`, "info");
  });
  // Cleanup on shutdown.
  // On session replacement (new/resume/fork): disconnect client but leave the
  // detached server running so the P2P network stays alive.
  // On quit/reload: kill the detached server process and clean up.
  pi.on("session_shutdown", async (event: SessionShutdownEvent, _ctx) => {
    if (persistReasons.has(event.reason)) {
      clearInvokeSession();
      // Just disconnect the client — server stays alive
      toolCtx.messageBus?.shutdown(false);
      toolCtx.widgetManager?.hideAll();
      return;
    }

    // Full teardown (quit / reload)
    if (toolCtx.agentName) {
      removeAgent(_ctx.cwd, toolCtx.agentName);

      const coordinator = getCoordinator(_ctx.cwd);
      if (coordinator?.name === toolCtx.agentName) {
        removeServerInfo(_ctx.cwd);
      }
    }

    clearInvokeSession();
    toolCtx.messageBus?.shutdown(true);
    toolCtx.widgetManager?.hideAll();
  });
}
