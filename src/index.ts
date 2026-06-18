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
- Immediately after request_approval_from_agent, stop the current turn. Do not call get_inbox and do not wait on irc.
- Approval decisions arrive through the structured approval protocol and will resume the delegated workflow automatically when delivered.
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
  // Put reply instructions FIRST and LAST so the OMP agent cannot miss them.
  // The skill body goes in the middle.
  const header = `## ⚠️  DELEGATED SKILL — REPLY REQUIRED

You are running skill "${skillName}" on behalf of pip2p agent **${invokerName}**.

${preamble}`;

  const footer = `## ⚠️  REMINDER — REPLY REQUIRED

When you finish this skill, you MUST use **reply_to_agent** to send your
results to **${invokerName}**'s inbox. Do NOT just display results locally —
${invokerName} cannot see your output unless you explicitly reply.`;

  const message = `${header}\n\n---\n\n## SKILL CONTENT\n\n${body}\n\n---\n\n${footer}\n\n${metaLines.join("\n")}`;
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
  explicitReplySent: boolean;
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
  let isActive = false;

  // Mutable context shared with tools — registered at factory time,
  // populated after activation so omp builds its active tool set correctly.
  const pendingApprovals = new Map<string, PendingApprovalEntry>();
  const toolCtx: ToolContext = {
    agentName: null,
    cwd: "",
    messageBus: null,
    widgetManager: null,
    suppressInboxPollingThisTurn: false,
    currentPrompt: "",
    currentInboundMessage: null,
    pendingApprovals,
  };

  // Register tools immediately so omp/pi includes them in the active tool set
  let activeInvokeSession: ActiveInvokeSession | null = null;

  function clearInvokeSession(): void {
    activeInvokeSession = null;
  }

  function relayInvokeSessionResponse(session: ActiveInvokeSession, text: string): void {
    if (!toolCtx.messageBus || !text) {
      return;
    }
    toolCtx.messageBus.sendMessage(session.requester, text, "response", {
      inReplyTo: session.requestMessageId,
      invokeThreadId: session.threadId,
      threadId: session.threadId,
    });
  }

  async function activatePip2p(
    ctx: { cwd: string; hasUI: boolean; ui: { notify: (message: string, level?: "info" | "warning" | "error" | "success") => void; setWidget: (key: string, lines: string[] | undefined) => void; } },
    agentName: string,
    reason: "manual" | "restore",
  ): Promise<{ role: "coordinator" | "worker"; isCoordinator: boolean }> {
    if (isActive && toolCtx.agentName === agentName && toolCtx.messageBus && toolCtx.widgetManager) {
      return {
        role: readServerInfo(ctx.cwd)?.coordinator === agentName ? "coordinator" : "worker",
        isCoordinator: readServerInfo(ctx.cwd)?.coordinator === agentName,
      };
    }

    toolCtx.agentName = agentName;
    toolCtx.cwd = ctx.cwd;

    const isNew = ensurePip2pDirs(ctx.cwd);
    ensureAgentInbox(ctx.cwd, agentName);
    if (isNew) {
      ensureGitignore(ctx.cwd);
    }

    toolCtx.widgetManager = new WidgetManager(agentName, ctx.cwd, ctx);
    toolCtx.widgetManager.syncFromDisk();

    toolCtx.messageBus = new MessageBus(agentName, ctx.cwd);

    toolCtx.messageBus.onMessage(async (msg) => {

      if (msg.type === "invoke-skill") {
        const skillName = msg.skillInvocation?.skillName?.trim();
        const args = msg.skillInvocation?.args?.trim();

        if (!skillName) {
          toolCtx.messageBus?.sendMessage(
            msg.from,
            `Failed to invoke skill: missing or malformed skill name in invoke-skill request ${msg.id}.`,
            "response",
            { inReplyTo: msg.id, threadId: msg.threadId ?? msg.id },
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
            threadId: msg.threadId ?? msg.id,
            explicitReplySent: false,
          };

          if (isOmpRuntime()) {
            const ompSkillResult = await buildOmpSkillPrompt(ctx.cwd, msg.from, skillName, args);
            if (!ompSkillResult.ok) {
              clearInvokeSession();
              toolCtx.messageBus?.sendMessage(
                msg.from,
                `Failed to invoke skill: ${ompSkillResult.error}`,
                "response",
                { inReplyTo: msg.id, threadId: msg.threadId ?? msg.id },
              );
              return;
            }

            toolCtx.currentInboundMessage = msg;
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
              { inReplyTo: msg.id, threadId: msg.threadId ?? msg.id },
            );
            return;
          }

          const delegatedMessage = `${buildDelegatedRunPreamble(msg.from)}\n\n${skillResult.command}`;
          toolCtx.currentInboundMessage = msg;
          pi.sendUserMessage(delegatedMessage);
        } catch (err) {
          clearInvokeSession();
          toolCtx.messageBus?.sendMessage(
            msg.from,
            `Failed to invoke skill "${skillName}": ${err instanceof Error ? err.message : String(err)}`,
            "response",
            { inReplyTo: msg.id, threadId: msg.threadId ?? msg.id },
          );
        }
        return;
      }

      if (msg.type === "response") {
        const isCoordinatorRecipient = readServerInfo(ctx.cwd)?.coordinator === toolCtx.agentName;

        if (isCoordinatorRecipient) {
          toolCtx.widgetManager?.addMessage(msg);
          return;
        }

        toolCtx.currentInboundMessage = msg;
        let instruction = `[pip2p] ${msg.from} replied: "${msg.content}"\n\nIMPORTANT:\n1. Continue based on this reply and SHOW your response to your user if you send one.\n2. If you need to answer ${msg.from}, use send_to_agent or reply_to_agent. Do NOT just reply in this conversation — ${msg.from} cannot see your responses here.\n3. If this message is only an acknowledgment, thanks, sign-off, closure note, "standing by", "forwarded to main", "got it", "ok", or emoji-only reply with no new request or question, do NOT respond. Stop immediately.\n4. After sending, STOP and wait for new user input or a new message.`;

        const skillName = detectSkillReference(msg.content);
        if (skillName) {
          instruction += `\n\nHint: ${msg.from} mentioned the "${skillName}" skill. You can invoke it with /skill:${skillName}`;
        }

        pi.sendUserMessage(instruction);
        return;
      }
      if (msg.type === "approval-request") {
        toolCtx.widgetManager?.addMessage(msg);
        return;
      }

      if (msg.type === "thread-resolved") {
        const coordinatorName = readServerInfo(ctx.cwd)?.coordinator;
        const threadId = msg.threadResolution?.threadId;
        if (coordinatorName && threadId && msg.from === coordinatorName) {
          toolCtx.widgetManager?.resolveThread(threadId);
        }
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

      const isCoordinatorRecipient = readServerInfo(ctx.cwd)?.coordinator === toolCtx.agentName;
      if (isCoordinatorRecipient) {
        toolCtx.widgetManager?.addMessage(msg);
        return;
      }

      toolCtx.currentInboundMessage = msg;

      let instruction = `[pip2p] ${msg.from} sent you a ${msg.type}: "${msg.content}"\n\nIMPORTANT:\n1. Work out your response and SHOW it to your user so they can see what you're sending.\n2. Use send_to_agent or reply_to_agent to send your response back to ${msg.from}. Do NOT just reply in this conversation — ${msg.from} cannot see your responses here.\n3. If this message is only an acknowledgment, thanks, sign-off, closure note, "standing by", "forwarded to main", "got it", "ok", or emoji-only reply with no new request or question, do NOT respond. Stop immediately.\n4. After sending, STOP and wait for new user input or a new message. Do NOT continue the conversation or invent follow-up requests.\n\nThe message content is already provided above — you do NOT need to call get_inbox.`;

      const skillName = detectSkillReference(msg.content);
      if (skillName) {
        instruction += `\n\nHint: ${msg.from} mentioned the "${skillName}" skill. You can invoke it with /skill:${skillName}`;
      }

      pi.sendUserMessage(instruction);
    });

    toolCtx.messageBus.onStatusChange((status: ConnectionStatus) => {
      connectionStatus = status;
      toolCtx.widgetManager?.updateAgentsWidget(status);
    });

    toolCtx.messageBus.onAgentJoin((_agent) => {
      toolCtx.widgetManager?.updateAgentsWidget(connectionStatus);
    });
    toolCtx.messageBus.onAgentLeave((_agentName) => {
      toolCtx.widgetManager?.updateAgentsWidget(connectionStatus);
    });

    const role = await toolCtx.messageBus.init();
    const serverInfo = readServerInfo(ctx.cwd);
    const isCoordinator = serverInfo?.coordinator === agentName;

    addAgent(ctx.cwd, {
      name: agentName,
      pid: process.pid,
      startedAt: Date.now(),
      isCoordinator,
      cwd: ctx.cwd,
    });

    connectionStatus = toolCtx.messageBus.getStatus();
    toolCtx.widgetManager.updateAgentsWidget(connectionStatus);
    isActive = true;
    ctx.ui.notify(`pip2p: ${agentName} ${reason === "restore" ? "reconnected" : "joined"} as ${isCoordinator ? "coordinator" : role}`, "info");
    return { role, isCoordinator };
  }

  function deactivatePip2p(cwd: string, options: { persist: boolean }): void {
    if (!isActive || !toolCtx.agentName) {
      return;
    }

    if (!options.persist) {
      removeAgent(cwd, toolCtx.agentName);
      const coordinator = getCoordinator(cwd);
      if (coordinator?.name === toolCtx.agentName) {
        removeServerInfo(cwd);
      }
    }

    clearInvokeSession();
    toolCtx.messageBus?.shutdown(!options.persist);
    toolCtx.widgetManager?.hideAll();
    toolCtx.messageBus = null;
    toolCtx.widgetManager = null;
    toolCtx.agentName = null;
    toolCtx.currentInboundMessage = null;
    isActive = false;
  }

  pi.on("tool_result", (event) => {
    if (!activeInvokeSession || event.toolName !== "reply_to_agent" || event.isError) {
      return;
    }
    const to = typeof event.input?.to === "string" ? event.input.to : undefined;
    if (to === activeInvokeSession.requester) {
      activeInvokeSession.explicitReplySent = true;
    }
  });

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

    relayInvokeSessionResponse(activeInvokeSession, text);
    clearInvokeSession();
  });

  pi.on("agent_end", (event) => {
    if (!isOmpRuntime() || !activeInvokeSession || !toolCtx.messageBus) {
      return;
    }
    if (activeInvokeSession.mode !== "interactive" || activeInvokeSession.explicitReplySent) {
      return;
    }

    const assistantMessages = event.messages.filter((message) => message.role === "assistant");
    for (let idx = assistantMessages.length - 1; idx >= 0; idx--) {
      const text = extractAssistantText(assistantMessages[idx] as { content?: Array<{ type?: string; text?: string }> });
      if (!text) {
        continue;
      }
      relayInvokeSessionResponse(activeInvokeSession, text);
      clearInvokeSession();
      return;
    }
  });
  const tools = createTools(toolCtx);
  for (const tool of tools) {
    pi.registerTool(tool as any);
  }

  const persistReasons: Set<string> = new Set(["new", "resume", "fork"]);

  pi.registerCommand("pip2p", {
    description: "Manage pip2p for this session: /pip2p, /pip2p status, /pip2p stop",
    handler: async (args, ctx) => {
      toolCtx.cwd = ctx.cwd;
      const subcommand = args.trim().toLowerCase();

      if (subcommand === "status") {
        if (!isActive || !toolCtx.agentName || !toolCtx.messageBus) {
          ctx.ui.notify("pip2p is inactive in this session.", "info");
          return;
        }

        const isCoordinator = readServerInfo(ctx.cwd)?.coordinator === toolCtx.agentName;
        ctx.ui.notify(
          `pip2p active as ${toolCtx.agentName} (${isCoordinator ? "coordinator" : "worker"}, ${toolCtx.messageBus.getStatus() === "live" ? "live" : "file mode"})`,
          "info",
        );
        return;
      }

      if (subcommand === "stop") {
        if (!isActive || !toolCtx.agentName) {
          ctx.ui.notify("pip2p is already inactive in this session.", "info");
          return;
        }

        const previousName = toolCtx.agentName;
        deactivatePip2p(ctx.cwd, { persist: false });
        ctx.ui.notify(`pip2p stopped for ${previousName}.`, "info");
        return;
      }

      if (subcommand && subcommand !== "start") {
        ctx.ui.notify("Usage: /pip2p, /pip2p status, /pip2p stop", "warning");
        return;
      }

      if (isActive && toolCtx.agentName && toolCtx.messageBus) {
        const isCoordinator = readServerInfo(ctx.cwd)?.coordinator === toolCtx.agentName;
        ctx.ui.notify(
          `pip2p active as ${toolCtx.agentName} (${isCoordinator ? "coordinator" : "worker"}, ${toolCtx.messageBus.getStatus() === "live" ? "live" : "file mode"})`,
          "info",
        );
        return;
      }

      const input = await ctx.ui.input("pip2p agent name", "Enter your pip2p agent name (e.g., alice, bob):");
      if (!input?.trim()) {
        ctx.ui.notify("pip2p was not started.", "warning");
        return;
      }

      await activatePip2p(ctx as any, input.trim(), "manual");
    },
  });

  pi.on("session_start", async (event: SessionStartEvent, ctx) => {
    if (!ctx.hasUI) return;

    toolCtx.cwd = ctx.cwd;

    let name: string | undefined;
    if (persistReasons.has(event.reason)) {
      const byPid = getAgentByPid(ctx.cwd, process.pid);
      if (byPid) {
        name = byPid.name;
      }
    }

    if (name) {
      await activatePip2p(ctx as any, name, "restore");
    }
  });

  pi.on("before_agent_start", (event: BeforeAgentStartEvent): BeforeAgentStartEventResult => {
    toolCtx.currentPrompt = event.prompt;
    toolCtx.suppressInboxPollingThisTurn = false;
    if (!event.prompt.startsWith("[pip2p] ")) {
      toolCtx.currentInboundMessage = null;
    }

    if (activeInvokeSession?.mode === "interactive" && !event.prompt.startsWith("[pip2p] ")) {
      clearInvokeSession();
    }

    if (!isActive || !toolCtx.agentName) {
      return { systemPrompt: event.systemPrompt };
    }

    let extra = buildIdentityBlock(toolCtx.agentName);
    if (activeInvokeSession) {
      extra += "\n\n" + buildDelegatedRunPreamble(activeInvokeSession.requester);
    }

    return { systemPrompt: event.systemPrompt + "\n\n" + extra };
  });

  pi.on("session_shutdown", async (event: SessionShutdownEvent, ctx) => {
    if (persistReasons.has(event.reason)) {
      deactivatePip2p(ctx.cwd, { persist: true });
      return;
    }

    deactivatePip2p(ctx.cwd, { persist: false });
  });
}
