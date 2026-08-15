/**
 * Widget Manager - manages a unified agents/inbox widget
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { getInboxDir } from "./agent-registry.js";
import { getEffectiveThreadId } from "./threading.js";
import type { PipMessage, AgentInfo, ConnectionStatus, ActivityState, InboxDeliveryMode } from "./types.js";

// ANSI color helpers for terminal rendering
const C = {
  bold: (s: string) => `\x1b[1m${s}\x1b[22m`,
  cyan: (s: string) => `\x1b[36m${s}\x1b[39m`,
  dim: (s: string) => `\x1b[2m${s}\x1b[22m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[39m`,
  reset: "\x1b[0m",
};

interface WidgetContext {
  ui: {
    setWidget: (key: string, lines: string[] | undefined) => void;
  };
}

export class WidgetManager {
  private inbox: PipMessage[] = [];
  private connectionStatus: ConnectionStatus = "file";
  private liveAgents: AgentInfo[] = [];
  private resolvedThreadIds: Set<string> = new Set();
  private coordinatorInboxMode: InboxDeliveryMode = "default";
  private isCoordinator = false;
  private spinnerFrame = 0;
  private spinnerTimer: ReturnType<typeof setInterval> | null = null;
  private readonly spinnerFrames = ["⣷", "⣯", "⣟", "⡿", "⢿", "⣻", "⣽", "⣾"];

  constructor(
    private agentName: string,
    private cwd: string,
    private ctx: WidgetContext,
  ) {}

  /**
   * Add a message to the inbox and update widgets
   */
  addMessage(message: PipMessage): void {
    // Don't add our own messages
    if (message.from === this.agentName) return;

    if (this.isThreadResolved(message)) return;

    // Don't add duplicates
    if (this.inbox.find((m) => m.id === message.id)) return;

    this.inbox.push(message);
    this.updateWidget();
  }

  /**
   * Mark messages as read and update widgets
   */
  markAllRead(): void {
    for (const msg of this.inbox) {
      msg.read = true;
      this.updateMessageFile(msg);
    }
    this.inbox = [];
    this.updateWidget();
  }

  /**
   * Mark messages from a specific agent as read
   */
  markReadFrom(from: string): PipMessage[] {
    const matched = this.inbox.filter((m) => m.from === from);
    for (const msg of matched) {
      msg.read = true;
      this.updateMessageFile(msg);
    }
    this.inbox = this.inbox.filter((m) => m.from !== from);
    this.updateWidget();
    return matched;
  }

  /**
   * Resolve an exact thread and remove its unread messages from badge state.
   */
  resolveThread(threadId: string): void {
    if (!threadId) return;

    this.resolvedThreadIds.add(threadId);
    this.saveResolvedThreads();

    const matched = this.inbox.filter((m) => !m.read && getEffectiveThreadId(m) === threadId);
    for (const msg of matched) {
      msg.read = true;
      this.updateMessageFile(msg);
    }

    this.inbox = this.inbox.filter((m) => getEffectiveThreadId(m) !== threadId);
    this.updateWidget();
  }

  /**
   * Get all unread messages
   */
  getUnread(): PipMessage[] {
    return this.inbox.filter((m) => !m.read);
  }

  /**
   * Get all messages
   */
  getAll(): PipMessage[] {
    return [...this.inbox];
  }

  /**
   * Sync inbox from disk (on startup)
   */
  syncFromDisk(): void {
    const inboxDir = getInboxDir(this.cwd, this.agentName);
    if (!fs.existsSync(inboxDir)) return;

    const files = fs.readdirSync(inboxDir).filter((f) => f.endsWith(".json"));
    this.inbox = [];
    this.loadResolvedThreads();

    for (const file of files) {
      try {
        const filePath = path.join(inboxDir, file);
        const data = fs.readFileSync(filePath, "utf-8");
        const msg = JSON.parse(data) as PipMessage;
        if (!msg.read && msg.from !== this.agentName && !this.isThreadResolved(msg)) {
          this.inbox.push(msg);
        }
      } catch {
        // Skip malformed files
      }
    }

    this.updateWidget();
  }

  /**
   * Update the unified agents + inbox widget.
   */
  setCoordinatorInboxMode(mode: InboxDeliveryMode, isCoordinator: boolean): void {
    this.coordinatorInboxMode = mode;
    this.isCoordinator = isCoordinator;
    this.updateWidget();
  }

  updateAgentsWidget(connectionStatus: ConnectionStatus, liveAgents: AgentInfo[] = []): void {
    this.connectionStatus = connectionStatus;
    this.liveAgents = [...liveAgents];
    this.updateWidget();
  }

  /**
   * Hide all widgets
   */
  hideAll(): void {
    this.stopSpinner();
    this.ctx.ui.setWidget(`${this.agentName}-agents`, undefined);
  }

  // --- Private ---

  /**
   * Render the unified widget with agents list and inline inbox badges.
   */
  private updateWidget(): void {
    const liveConnections = this.liveAgents
      .filter((agent) => agent.name !== this.agentName)
      .sort((a, b) => Number(b.isCoordinator) - Number(a.isCoordinator));
    const hasRunningPeer = liveConnections.some((agent) => agent.activity === "running");

    if (hasRunningPeer) {
      this.startSpinner();
    } else {
      this.stopSpinner();
    }

    if (liveConnections.length === 0) {
      if (this.connectionStatus === "file") {
        const width = (process.stdout.columns || 80) - 2;
        this.ctx.ui.setWidget(`${this.agentName}-agents`, ["─".repeat(width), "Agents: 🟡 File Mode"]);
      } else {
        this.ctx.ui.setWidget(`${this.agentName}-agents`, undefined);
      }
      return;
    }

    const statusIndicator = this.connectionStatus === "live" ? "🟢 Live" : "🟡 File Mode";
    // Count unread per sender
    const unreadBySender = new Map<string, PipMessage[]>();
    for (const msg of this.inbox.filter((m) => !m.read && !this.isThreadResolved(m))) {
      const existing = unreadBySender.get(msg.from) || [];
      existing.push(msg);
      unreadBySender.set(msg.from, existing);
    }

    const maxNameLen = Math.max(...liveConnections.map((agent) => agent.name.length));
    const width = (process.stdout.columns || 80) - 2;
    const approvalCount = this.inbox.filter((msg) => !msg.read && msg.type === "approval-request" && !this.isThreadResolved(msg)).length;
    const modeIndicator = this.isCoordinator && this.coordinatorInboxMode === "auto-inject"
      ? ` ⚡${approvalCount > 0 ? ` 📥 ${C.bold(C.yellow(`(${approvalCount})`))}` : ""}`
      : "";
    const lines: string[] = ["─".repeat(width), `Agents: ${statusIndicator}${modeIndicator}`];

    const activityIndicator = (activity: ActivityState) => {
      switch (activity) {
        case "idle": return "·";
        case "running": return this.spinnerFrames[this.spinnerFrame];
        default: return C.dim("?");
      }
    };

    const renderAgent = (agent: AgentInfo) => {
      const icon = agent.isCoordinator ? "👑" : "🔧";
      const paddedName = agent.isCoordinator
        ? C.bold(C.cyan(agent.name.padEnd(maxNameLen)))
        : agent.name.padEnd(maxNameLen);
      const act = activityIndicator(agent.activity ?? "unknown");
      const unread = unreadBySender.get(agent.name);
      const showOrdinaryUnread = !this.isCoordinator || this.coordinatorInboxMode === "default";
      const ordinaryBadge = showOrdinaryUnread && unread && unread.length > 0
        ? `  📨 ${C.bold(C.yellow(`(${unread.length})`))}${this.getSkillBadge(unread)}`
        : "";
      const inboxBadge = ordinaryBadge;
      const approvalBadge = this.isCoordinator && this.coordinatorInboxMode === "auto-inject" && approvalCount > 0 && agent.name === this.agentName
        ? `  📥 ${C.bold(C.yellow(`(${approvalCount})`))}`
        : "";
      lines.push(`${icon} ${paddedName}  ${act}${inboxBadge}${approvalBadge}`);
    };

    for (const agent of liveConnections) renderAgent(agent);

    this.ctx.ui.setWidget(`${this.agentName}-agents`, lines);
  }

  private startSpinner(): void {
    if (this.spinnerTimer) return;

    this.spinnerTimer = setInterval(() => {
      this.spinnerFrame = (this.spinnerFrame + 1) % this.spinnerFrames.length;
      this.updateWidget();
    }, 120);
  }

  private stopSpinner(): void {
    if (!this.spinnerTimer) return;

    clearInterval(this.spinnerTimer);
    this.spinnerTimer = null;
    this.spinnerFrame = 0;
  }

  private getSkillBadge(messages: PipMessage[]): string {
    const patterns = [
      /run\s+(\S+)\s+skill/i,
      /use\s+(\S+)\s+skill/i,
      /invoke\s+(\S+)\s+skill/i,
      /\/skill:(\S+)/,
      /skill\s*:\s*(\S+)/i,
    ];

    for (const msg of messages) {
      for (const pattern of patterns) {
        const match = msg.content.match(pattern);
        if (match) {
          return ` 🔧 ${match[1]}`;
        }
      }
    }
    return "";
  }

  private updateMessageFile(msg: PipMessage): void {
    const inboxDir = getInboxDir(this.cwd, this.agentName);
    const filePath = path.join(inboxDir, `${msg.id}.json`);
    if (fs.existsSync(filePath)) {
      fs.writeFileSync(filePath, JSON.stringify(msg, null, 2));
    }
  }

  private isThreadResolved(msg: PipMessage): boolean {
    return this.resolvedThreadIds.has(getEffectiveThreadId(msg));
  }

  private getResolvedThreadsFilePath(): string {
    const resolvedDir = path.join(this.cwd, ".pip2p", "resolved-threads");
    fs.mkdirSync(resolvedDir, { recursive: true });
    return path.join(resolvedDir, `${this.agentName}.json`);
  }

  private loadResolvedThreads(): void {
    const filePath = this.getResolvedThreadsFilePath();
    if (!fs.existsSync(filePath)) {
      this.resolvedThreadIds = new Set();
      return;
    }

    try {
      const data = JSON.parse(fs.readFileSync(filePath, "utf-8")) as { resolvedThreadIds?: string[] };
      this.resolvedThreadIds = new Set(data.resolvedThreadIds ?? []);
    } catch {
      this.resolvedThreadIds = new Set();
    }
  }

  private saveResolvedThreads(): void {
    const filePath = this.getResolvedThreadsFilePath();
    fs.writeFileSync(filePath, JSON.stringify({ resolvedThreadIds: [...this.resolvedThreadIds] }, null, 2));
  }
}
