/**
 * WebSocket Client - connects to the coordinator's server
 */

import WebSocket from "ws";
import type {
  WsClientMessage,
  WsServerMessage,
  AgentInfo,
  PipMessage,
  ActivityState,
} from "./types.js";
import { readServerInfo } from "./agent-registry.js";

export type ClientStatus = "connecting" | "connected" | "disconnected";

export class PipClient {
  private ws: WebSocket | null = null;
  private status: ClientStatus = "disconnected";
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 10;
  private reconnectDelay = 2000;

  private onMessageCallback: ((msg: PipMessage) => void) | null = null;
  private onRegistryCallback: ((agents: AgentInfo[]) => void) | null = null;
  private onStatusChangeCallback: ((status: ClientStatus) => void) | null = null;
  private onDisconnectCallback: (() => void) | null = null;
  private onAgentJoinCallback: ((agent: AgentInfo) => void) | null = null;
  private onAgentLeaveCallback: ((agentName: string) => void) | null = null;
  private onActivityChangeCallback: ((data: { agent: string; activity: ActivityState }) => void) | null = null;

  constructor(
    private agentName: string,
    private pid: number,
    private cwd: string,
  ) {}

  /**
   * Connect to the coordinator's WebSocket server
   */
  connect(port: number): void {
    this.status = "connecting";
    this.notifyStatusChange();

    try {
      this.ws = new WebSocket(`ws://localhost:${port}`);

      this.ws.on("open", () => {
        this.status = "connected";
        this.reconnectAttempts = 0;
        this.notifyStatusChange();

        // Register with server
        const registerMsg: WsClientMessage = {
          type: "register",
          agent: { name: this.agentName, pid: this.pid },
        };
        this.ws!.send(JSON.stringify(registerMsg));
      });

      this.ws.on("message", (data) => {
        try {
          const msg = JSON.parse(data.toString()) as WsServerMessage;
          this.handleServerMessage(msg);
        } catch {
          // Ignore malformed messages
        }
      });

      this.ws.on("close", () => {
        this.status = "disconnected";
        this.notifyStatusChange();
        this.onDisconnectCallback?.();
        this.tryReconnect();
      });

      this.ws.on("error", () => {
        // Error handler - close event will fire after this
      });
    } catch {
      this.status = "disconnected";
      this.notifyStatusChange();
      this.tryReconnect();
    }
  }

  /**
   * Disconnect from the server
   */
  disconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.reconnectAttempts = this.maxReconnectAttempts; // Prevent reconnect
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.status = "disconnected";
    this.notifyStatusChange();
  }

  /**
   * Send a message to another agent via the server
   */
  sendTo(agentName: string, payload: PipMessage): boolean {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      const msg: WsClientMessage = {
        type: "message",
        to: agentName,
        payload,
      };
      this.ws.send(JSON.stringify(msg));
      return true;
    }
    return false;
  }

  /**
   * Get current connection status
   */
  getStatus(): ClientStatus {
    return this.status;
  }

  // --- Callbacks ---

  onMessage(callback: (msg: PipMessage) => void): void {
    this.onMessageCallback = callback;
  }

  onRegistry(callback: (agents: AgentInfo[]) => void): void {
    this.onRegistryCallback = callback;
  }

  onStatusChange(callback: (status: ClientStatus) => void): void {
    this.onStatusChangeCallback = callback;
  }

  onDisconnect(callback: () => void): void {
    this.onDisconnectCallback = callback;
  }

  onAgentJoin(callback: (agent: AgentInfo) => void): void {
    this.onAgentJoinCallback = callback;
  }

  onAgentLeave(callback: (agentName: string) => void): void {
    this.onAgentLeaveCallback = callback;
  }

  onActivityChange(callback: (data: { agent: string; activity: ActivityState }) => void): void {
    this.onActivityChangeCallback = callback;
  }

  sendSetActivity(activity: ActivityState): boolean {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      const msg: WsClientMessage = {
        type: "set_activity",
        agent: this.agentName,
        activity,
      };
      this.ws.send(JSON.stringify(msg));
      return true;
    }
    return false;
  }

  // --- Private ---

  private handleServerMessage(msg: WsServerMessage): void {
    switch (msg.type) {
      case "registry":
        this.onRegistryCallback?.(msg.agents);
        break;
      case "message":
        this.onMessageCallback?.(msg.payload);
        break;
      case "agent_joined":
        this.onAgentJoinCallback?.(msg.agent);
        break;
      case "agent_left":
        this.onAgentLeaveCallback?.(msg.agent);
        break;
      case "activity_changed":
        this.onActivityChangeCallback?.({ agent: msg.agent, activity: msg.activity });
        break;
    }
  }

  /**
   * Attempt reconnection by re-reading server info for the current port.
   * This handles the case where the coordinator restarted on a new port
   * after a session replacement (/new, /resume, /fork).
   */
  private tryReconnect(): void {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      return;
    }

    this.reconnectAttempts++;
    const delay = this.reconnectDelay * Math.min(this.reconnectAttempts, 5);

    this.reconnectTimer = setTimeout(() => {
      // Re-read server info to pick up new port after coordinator restart
      const serverInfo = readServerInfo(this.cwd);
      if (serverInfo) {
        this.connect(serverInfo.port);
      } else {
        // No server info yet, retry later
        this.tryReconnect();
      }
    }, delay);
  }

  private notifyStatusChange(): void {
    this.onStatusChangeCallback?.(this.status);
  }
}
