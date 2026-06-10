/**
 * Widget Manager - manages inbox and agents widgets
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { getInboxDir, getOtherAgents } from "./agent-registry.js";
import type { PipMessage, AgentInfo, ConnectionStatus } from "./types.js";

interface WidgetContext {
  ui: {
    setWidget: (key: string, lines: string[] | undefined) => void;
  };
}

export class WidgetManager {
  private inbox: PipMessage[] = [];

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
    this.updateInboxWidget();
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
    this.updateInboxWidget();
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
    this.updateInboxWidget();
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

    this.updateInboxWidget();
  }

  /**
   * Update the agents widget
   */
  updateAgentsWidget(connectionStatus: ConnectionStatus): void {
    const otherAgents = getOtherAgents(this.cwd, this.agentName);

    if (otherAgents.length === 0) {
      this.ctx.ui.setWidget(`${this.agentName}-agents`, undefined);
      return;
    }

    const statusIndicator = connectionStatus === "live" ? "🟢 Live" : "🟡 File Mode";
    const lines: string[] = [`Agents: ${statusIndicator}`];

    for (const agent of otherAgents) {
      const marker = agent.isCoordinator ? "👑 " : "   ";
      lines.push(`${marker}${agent.name}`);
    }

    this.ctx.ui.setWidget(`${this.agentName}-agents`, lines);
  }

  /**
   * Update the inbox widget
   */
  updateInboxWidget(): void {
    const unread = this.inbox.filter((m) => !m.read);

    if (unread.length === 0) {
      this.ctx.ui.setWidget(`${this.agentName}-inbox`, undefined);
      return;
    }

    // Group by sender
    const grouped = new Map<string, PipMessage[]>();
    for (const msg of unread) {
      const existing = grouped.get(msg.from) || [];
      existing.push(msg);
      grouped.set(msg.from, existing);
    }

    // Calculate padding for alignment
    const maxLen = Math.max(...Array.from(grouped.keys()).map((n) => n.length));

    const lines: string[] = [];
    for (const [from, msgs] of grouped) {
      const padded = from.padEnd(maxLen);
      const skillBadge = this.getSkillBadge(msgs);
      lines.push(`⚡ ${padded} (${msgs.length})${skillBadge}`);
    }

    this.ctx.ui.setWidget(`${this.agentName}-inbox`, lines);
  }

  /**
   * Hide all widgets
   */
  hideAll(): void {
    this.ctx.ui.setWidget(`${this.agentName}-inbox`, undefined);
    this.ctx.ui.setWidget(`${this.agentName}-agents`, undefined);
  }

  // --- Private ---

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
