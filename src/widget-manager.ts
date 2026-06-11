/**
 * Widget Manager - manages a unified agents/inbox widget
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { getInboxDir, getOtherAgents } from "./agent-registry.js";
import type { PipMessage, AgentInfo, ConnectionStatus } from "./types.js";

// ANSI color helpers for terminal rendering
const C = {
  bold: (s: string) => `\x1b[1m${s}\x1b[22m`,
  cyan: (s: string) => `\x1b[36m${s}\x1b[39m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[39m`,
  dim: (s: string) => `\x1b[2m${s}\x1b[22m`,
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

    for (const file of files) {
      try {
        const filePath = path.join(inboxDir, file);
        const data = fs.readFileSync(filePath, "utf-8");
        const msg = JSON.parse(data) as PipMessage;
        if (!msg.read && msg.from !== this.agentName) {
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
  updateAgentsWidget(connectionStatus: ConnectionStatus): void {
    this.connectionStatus = connectionStatus;
    this.updateWidget();
  }

  /**
   * Hide all widgets
   */
  hideAll(): void {
    this.ctx.ui.setWidget(`${this.agentName}-agents`, undefined);
  }

  // --- Private ---

  /**
   * Render the unified widget with agents list and inline inbox badges.
   */
  private updateWidget(): void {
    const otherAgents = getOtherAgents(this.cwd, this.agentName);

    if (otherAgents.length === 0) {
      this.ctx.ui.setWidget(`${this.agentName}-agents`, undefined);
      return;
    }

    const statusIndicator = this.connectionStatus === "live" ? "🟢 Live" : "🟡 File Mode";

    // Count unread per sender
    const unreadBySender = new Map<string, PipMessage[]>();
    for (const msg of this.inbox.filter((m) => !m.read)) {
      const existing = unreadBySender.get(msg.from) || [];
      existing.push(msg);
      unreadBySender.set(msg.from, existing);
    }

    // Calculate name padding for alignment
    const maxNameLen = Math.max(...otherAgents.map((a) => a.name.length));

    const width = (process.stdout.columns || 80) - 2;
    const lines: string[] = ["─".repeat(width), `Agents: ${statusIndicator}`];

    for (const agent of otherAgents) {
      const icon = agent.isCoordinator ? "👑" : "🔧";
      const paddedName = agent.isCoordinator
        ? C.bold(C.cyan(agent.name.padEnd(maxNameLen)))
        : agent.name.padEnd(maxNameLen);

      const unread = unreadBySender.get(agent.name);
      let inboxBadge = "";
      if (unread && unread.length > 0) {
        const skillBadge = this.getSkillBadge(unread);
        inboxBadge = `  ⚡ ${C.bold(C.yellow(`(${unread.length})`))}${skillBadge}`;
      }

      lines.push(` ${icon} ${paddedName}${inboxBadge}`);
    }

    this.ctx.ui.setWidget(`${this.agentName}-agents`, lines);
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
}
