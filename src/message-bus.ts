/**
 * Message Bus - dual-mode messaging (WebSocket + file-based fallback)
 *
 * The WebSocket server runs as a detached child process (server-runner.mjs)
 * so it survives session replacement (/new, /resume, /fork). All agents,
 * including the coordinator, connect as clients.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as url from "node:url";
import * as child_process from "node:child_process";
import { PipClient, type ClientStatus } from "./client.js";
import { FileWatcher, type MessageHandler } from "./file-watcher.js";
import {
  getInboxDir,
  readServerInfo,
  writeServerInfo,
  isCoordinatorAlive,
  removeServerInfo,
} from "./agent-registry.js";
import type { PipMessage, ConnectionStatus, MessageType, AgentInfo, ActivityState } from "./types.js";

export interface SendMessageOptions {
  inReplyTo?: PipMessage["inReplyTo"];
  skillInvocation?: PipMessage["skillInvocation"];
  invokeThreadId?: PipMessage["invokeThreadId"];
  approvalRequest?: PipMessage["approvalRequest"];
  approvalDecision?: PipMessage["approvalDecision"];
  threadResolution?: PipMessage["threadResolution"];
  threadId?: PipMessage["threadId"];
}

export type StatusChangeHandler = (status: ConnectionStatus) => void;

export class MessageBus {
  private client: PipClient | null = null;
  private fileWatcher: FileWatcher | null = null;
  private serverProcess: child_process.ChildProcess | null = null;
  private status: ConnectionStatus = "file";
  private statusHandlers: StatusChangeHandler[] = [];
  private messageHandlers: MessageHandler[] = [];

  // Track recent messages for smart reply detection
  private recentIncoming: Map<string, PipMessage> = new Map(); // from agent -> last message
  private recentOutgoing: Map<string, PipMessage> = new Map(); // to agent -> last message

  // Track processed message IDs to prevent duplicates
  private processedMessageIds: Set<string> = new Set();

  // Callbacks for agent join/leave (forwarded from client)
  private agentJoinCallbacks: ((agent: AgentInfo) => void)[] = [];
  private agentLeaveCallbacks: ((agentName: string) => void)[] = [];
  private liveAgents: AgentInfo[] = [];
  private liveAgentHandlers: ((agents: AgentInfo[]) => void)[] = [];

  // Local Activity state — reported to peers over WS transport
  private activity: ActivityState = "unknown";
  private activityReassertTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private agentName: string,
    private cwd: string,
  ) {}

  /**
   * Initialize the message bus.
   * If a server is already running, connect as client.
   * Otherwise, spawn the detached server and connect as client.
   */
  async init(): Promise<"coordinator" | "worker"> {
    // Ensure inbox directory exists
    const inboxDir = getInboxDir(this.cwd, this.agentName);
    fs.mkdirSync(inboxDir, { recursive: true });

    // Always start file watcher as fallback
    this.startFileWatcher();

    // Check if server is already running
    if (isCoordinatorAlive(this.cwd)) {
      const serverInfo = readServerInfo(this.cwd);
      if (serverInfo) {
        this.startClient(serverInfo.port);
        return "worker";
      }
    }

    // Spawn the detached server and connect as coordinator
    await this.spawnServer();
    return "coordinator";
  }

  /**
   * Send a message to another agent
   */
  sendMessage(
    to: string,
    content: string,
    type: MessageType = "task",
    options: SendMessageOptions = {},
  ): PipMessage {
    const {
      inReplyTo,
      skillInvocation,
      invokeThreadId,
      approvalRequest,
      approvalDecision,
      threadResolution,
      threadId,
    } = options;

    const message: PipMessage = {
      id: crypto.randomUUID(),
      from: this.agentName,
      to,
      content,
      timestamp: Date.now(),
      read: false,
      type,
      threadId,
      inReplyTo,
      skillInvocation,
      approvalRequest,
      approvalDecision,
      threadResolution,
      invokeThreadId,
    };

    // Track outgoing message
    this.recentOutgoing.set(to, message);

    if (this.status === "live") {
      // Live mode: send via WebSocket client
      this.client?.sendTo(to, message);
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

  /** Get the current transport-connected peer roster. */
  getLiveAgents(): AgentInfo[] {
    return [...this.liveAgents];
  }

  /** Set local Activity state and report it to peers when live. */
  setLocalActivity(activity: ActivityState): void {
    if (this.activity === activity) return;
    this.activity = activity;

    // Manage re-assertion timer: re-send while running, stop otherwise
    if (activity === "running") {
      if (!this.activityReassertTimer) {
        this.activityReassertTimer = setInterval(() => {
          if (this.status === "live") {
            this.client?.sendSetActivity("running");
          }
        }, 30_000);
      }
    } else {
      if (this.activityReassertTimer) {
        clearInterval(this.activityReassertTimer);
        this.activityReassertTimer = null;
      }
    }

    if (this.status === "live") {
      this.client?.sendSetActivity(activity);
    }
  }

  /** Get the local agent's own Activity state. */
  getLocalActivity(): ActivityState {
    return this.activity;
  }

  /** Get a peer's cached Activity state (defaults to unknown). */
  getAgentActivity(name: string): ActivityState {
    const agent = this.liveAgents.find((a) => a.name === name);
    return agent?.activity ?? "unknown";
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
   * Register a handler for agent join events
   */
  onAgentJoin(handler: (agent: AgentInfo) => void): void {
    this.agentJoinCallbacks.push(handler);
  }

  /**
   * Register a handler for agent leave events
   */
  onAgentLeave(handler: (agentName: string) => void): void {
    this.agentLeaveCallbacks.push(handler);
  }

  onLiveAgentsChange(handler: (agents: AgentInfo[]) => void): void {
    this.liveAgentHandlers.push(handler);
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
   * Shutdown the message bus.
   * @param killServer - If true, kill the detached server process (used on quit/reload).
   */
  shutdown(killServer = false): void {
    if (this.activityReassertTimer) {
      clearInterval(this.activityReassertTimer);
      this.activityReassertTimer = null;
    }
    this.fileWatcher?.stop();
    this.client?.disconnect();
    if (killServer && this.serverProcess) {
      this.serverProcess.kill("SIGTERM");
      this.serverProcess = null;
    }
  }

  // --- Private ---

  /**
   * Spawn the detached server-runner.mjs process and wait for it to be ready.
   * Then connect as a client.
   */
  private async spawnServer(): Promise<void> {
    const thisDir = path.dirname(url.fileURLToPath(import.meta.url));
    const runnerPath = path.join(thisDir, "server-runner.mjs");

    this.serverProcess = child_process.spawn(
      process.execPath,
      [runnerPath, "--cwd", this.cwd, "--coordinator", this.agentName, "--coordinator-pid", String(process.pid)],
      {
        detached: true,
        stdio: "ignore",
      },
    );
    this.serverProcess.unref();

    // Wait for server.json to appear (server writes it once listening)
    const port = await this.waitForServerInfo();

    // Connect to our own server as a client
    this.startClient(port);
  }

  /**
   * Wait for the server runner to write server.json, then return the port.
   */
  private waitForServerInfo(maxWaitMs = 5000): Promise<number> {
    return new Promise((resolve, reject) => {
      const startTime = Date.now();
      const poll = () => {
        const info = readServerInfo(this.cwd);
        if (info) {
          resolve(info.port);
          return;
        }
        if (Date.now() - startTime > maxWaitMs) {
          reject(new Error("Timed out waiting for server info"));
          return;
        }
        setTimeout(poll, 100);
      };
      poll();
    });
  }

  private startClient(port: number): void {
    this.client = new PipClient(this.agentName, process.pid, this.cwd);

    this.client.onMessage((msg) => {
      this.handleIncomingMessage(msg);
    });

    this.client.onStatusChange((status: ClientStatus) => {
      if (status === "connected") {
        this.setStatus("live");
        // Send current Activity state once on connect so peers seed their view
        this.client?.sendSetActivity(this.activity);
      } else if (status === "disconnected") {
        this.setLiveAgents([]);
        this.setStatus("file");
      }
    });

    this.client.onRegistry((agents: AgentInfo[]) => {
      this.setLiveAgents(agents);
    });

    this.client.onAgentJoin((agent: AgentInfo) => {
      this.setLiveAgents([...this.liveAgents.filter((existing) => existing.name !== agent.name), agent]);
      for (const cb of this.agentJoinCallbacks) cb(agent);
    });

    this.client.onAgentLeave((agentName: string) => {
      this.setLiveAgents(this.liveAgents.filter((agent) => agent.name !== agentName));
      for (const cb of this.agentLeaveCallbacks) cb(agentName);
    });

    this.client.onActivityChange(({ agent, activity }) => {
      const idx = this.liveAgents.findIndex((a) => a.name === agent);
      if (idx === -1) return;
      this.liveAgents[idx] = { ...this.liveAgents[idx], activity };
      const snapshot = this.getLiveAgents();
      for (const handler of this.liveAgentHandlers) {
        handler(snapshot);
      }
    });

    this.client.onDisconnect(() => {
      // Don't try takeover — the detached server handles its own lifecycle.
      // If the server died, file watcher is the fallback.
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

    // Prevent duplicate processing (same message arriving via multiple channels)
    if (this.processedMessageIds.has(msg.id)) return;
    this.processedMessageIds.add(msg.id);

    // Keep the set from growing too large (retain last 1000 message IDs)
    if (this.processedMessageIds.size > 1000) {
      const firstKey = this.processedMessageIds.values().next().value;
      if (firstKey) this.processedMessageIds.delete(firstKey);
    }

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

  private setLiveAgents(agents: AgentInfo[]): void {
    this.liveAgents = agents;
    const snapshot = this.getLiveAgents();
    for (const handler of this.liveAgentHandlers) {
      handler(snapshot);
    }
  }

  private setStatus(status: ConnectionStatus): void {
    if (this.status === status) return;
    this.status = status;
    for (const handler of this.statusHandlers) {
      handler(status);
    }
  }
}
