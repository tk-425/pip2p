/**
 * WebSocket Client - connects to the coordinator's server
 */

import WebSocket from "ws";
import type {
  WsClientMessage,
  WsServerMessage,
  AgentInfo,
  PipMessage,
} from "./types.js";

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

  constructor(
    private agentName: string,
    private pid: number,
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
        this.tryReconnect(port);
      });

      this.ws.on("error", () => {
        // Error handler - close event will fire after this
      });
    } catch {
      this.status = "disconnected";
      this.notifyStatusChange();
      this.tryReconnect(port);
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
        // Registry will be sent separately
        break;
      case "agent_left":
        // Registry will be sent separately
        break;
    }
  }

  private tryReconnect(port: number): void {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      return;
    }

    this.reconnectAttempts++;
    const delay = this.reconnectDelay * Math.min(this.reconnectAttempts, 5);

    this.reconnectTimer = setTimeout(() => {
      this.connect(port);
    }, delay);
  }

  private notifyStatusChange(): void {
    this.onStatusChangeCallback?.(this.status);
  }
}
