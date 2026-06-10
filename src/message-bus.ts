/**
 * Message Bus - dual-mode messaging (WebSocket + file-based fallback)
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { PipServer } from "./server.js";
import { PipClient, type ClientStatus } from "./client.js";
import { FileWatcher, type MessageHandler } from "./file-watcher.js";
import { getInboxDir, readServerInfo, writeServerInfo, isCoordinatorAlive } from "./agent-registry.js";
import type { PipMessage, ConnectionStatus, MessageType } from "./types.js";

export type StatusChangeHandler = (status: ConnectionStatus) => void;

export class MessageBus {
  private server: PipServer | null = null;
  private client: PipClient | null = null;
  private fileWatcher: FileWatcher | null = null;
  private status: ConnectionStatus = "file";
  private statusHandlers: StatusChangeHandler[] = [];
  private messageHandlers: MessageHandler[] = [];

  // Track recent messages for smart reply detection
  private recentIncoming: Map<string, PipMessage> = new Map(); // from agent -> last message
  private recentOutgoing: Map<string, PipMessage> = new Map(); // to agent -> last message

  constructor(
    private agentName: string,
    private cwd: string,
  ) {}

  /**
   * Initialize the message bus.
   * If coordinator is alive, connect as client.
   * Otherwise, start as coordinator/server.
   */
  async init(): Promise<"coordinator" | "worker"> {
    // Ensure inbox directory exists
    const inboxDir = getInboxDir(this.cwd, this.agentName);
    fs.mkdirSync(inboxDir, { recursive: true });

    // Always start file watcher as fallback
    this.startFileWatcher();

    // Check if coordinator is alive
    if (isCoordinatorAlive(this.cwd)) {
      // Connect as worker
      const serverInfo = readServerInfo(this.cwd);
      if (serverInfo) {
        this.startClient(serverInfo.port);
        return "worker";
      }
    }

    // Start as coordinator
    await this.startServer();
    return "coordinator";
  }

  /**
   * Send a message to another agent
   */
  sendMessage(to: string, content: string, type: MessageType = "task", inReplyTo?: string): PipMessage {
    const message: PipMessage = {
      id: crypto.randomUUID(),
      from: this.agentName,
      to,
      content,
      timestamp: Date.now(),
      read: false,
      type,
      inReplyTo,
    };

    // Track outgoing message
    this.trackOutgoing(message);

    if (this.status === "live") {
      // Live mode: use WebSocket only
      if (this.server) {
        // We're the coordinator, send via server
        this.server.sendTo(to, message);
      } else if (this.client) {
        // We're a worker, send via client
        this.client.sendTo(to, message);
      }
    } else {
      // File mode: write to file
      this.writeToFile(to, message);
    }

    return message;
  }

  /**
   * Get current connection status
   */
  getStatus(): ConnectionStatus {
    return this.status;
  }

  /**
   * Register a handler for incoming messages
   */
  onMessage(handler: MessageHandler): void {
    this.messageHandlers.push(handler);
  }

  /**
   * Register a handler for connection status changes
   */
  onStatusChange(handler: StatusChangeHandler): void {
    this.statusHandlers.push(handler);
  }

  /**
   * Get the server instance (only available if this agent is the coordinator)
   */
  getServer(): PipServer | null {
    return this.server;
  }

  /**
   * Track an incoming message (called from onMessage handler)
   */
  trackIncoming(msg: PipMessage): void {
    this.recentIncoming.set(msg.from, msg);
  }

  /**
   * Track an outgoing message (called from sendMessage)
   */
  trackOutgoing(msg: PipMessage): void {
    this.recentOutgoing.set(msg.to, msg);
  }

  /**
   * Check if a specific agent recently sent us a message (within 5 minutes)
   */
  hasRecentFrom(agentName: string): PipMessage | null {
    const msg = this.recentIncoming.get(agentName);
    if (!msg) return null;
    // Only consider messages from the last 5 minutes
    if (Date.now() - msg.timestamp > 5 * 60 * 1000) {
      this.recentIncoming.delete(agentName);
      return null;
    }
    return msg;
  }

  /**
   * Shutdown the message bus
   */
  shutdown(): void {
    this.fileWatcher?.stop();
    this.client?.disconnect();
    this.server?.stop();
  }

  // --- Private ---

  private async startServer(): Promise<void> {
    this.server = new PipServer();
    const port = await PipServer.findFreePort();
    await this.server.start(port);

    // Write server info
    writeServerInfo(this.cwd, {
      port,
      coordinator: this.agentName,
      pid: process.pid,
      startedAt: Date.now(),
    });

    // Handle incoming messages from other agents
    this.server.onMessage((msg) => {
      this.handleIncomingMessage(msg);
    });

    this.setStatus("live");
  }

  private startClient(port: number): void {
    this.client = new PipClient(this.agentName, process.pid);

    this.client.onMessage((msg) => {
      this.handleIncomingMessage(msg);
    });

    this.client.onStatusChange((status: ClientStatus) => {
      if (status === "connected") {
        this.setStatus("live");
      } else if (status === "disconnected") {
        this.setStatus("file");
      }
    });

    this.client.onDisconnect(() => {
      // Try to take over as coordinator if coordinator died
      this.tryTakeover();
    });

    this.client.connect(port);
  }

  private startFileWatcher(): void {
    const inboxDir = getInboxDir(this.cwd, this.agentName);
    this.fileWatcher = new FileWatcher(inboxDir, (msg) => {
      this.handleIncomingMessage(msg);
    });
    this.fileWatcher.start();
  }

  private handleIncomingMessage(msg: PipMessage): void {
    // Don't process our own messages
    if (msg.from === this.agentName) return;

    // Track incoming message for smart reply detection
    this.trackIncoming(msg);

    // Only write to file in file mode (in live mode, WebSocket handles delivery)
    if (this.status === "file") {
      this.writeToFile(this.agentName, msg);
    }

    // Notify handlers
    for (const handler of this.messageHandlers) {
      handler(msg);
    }
  }

  private writeToFile(agentName: string, message: PipMessage): void {
    const inboxDir = getInboxDir(this.cwd, agentName);
    fs.mkdirSync(inboxDir, { recursive: true });
    const filePath = path.join(inboxDir, `${message.id}.json`);
    fs.writeFileSync(filePath, JSON.stringify(message, null, 2));
  }

  private setStatus(status: ConnectionStatus): void {
    if (this.status === status) return;
    this.status = status;
    for (const handler of this.statusHandlers) {
      handler(status);
    }
  }

  private async tryTakeover(): Promise<void> {
    // Check if coordinator is actually dead
    if (isCoordinatorAlive(this.cwd)) return;

    try {
      // Stop file watcher temporarily
      this.fileWatcher?.stop();

      // Start server
      await this.startServer();

      // Restart file watcher
      this.startFileWatcher();
    } catch {
      // Another agent took over, restart file watcher
      this.startFileWatcher();
    }
  }
}
