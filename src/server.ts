/**
 * WebSocket Server - runs on the coordinator agent
 */

import { WebSocketServer, WebSocket } from "ws";
import * as net from "node:net";
import type {
  AgentInfo,
  WsClientMessage,
  WsServerMessage,
  PipMessage,
} from "./types.js";

export class PipServer {
  private wss: WebSocketServer | null = null;
  private clients: Map<string, WebSocket> = new Map();
  private agents: AgentInfo[] = [];
  private onMessageCallback: ((msg: PipMessage) => void) | null = null;
  private onAgentJoinCallback: ((agent: AgentInfo) => void) | null = null;
  private onAgentLeaveCallback: ((agentName: string) => void) | null = null;

  /**
   * Find a free port on the local machine
   */
  static async findFreePort(): Promise<number> {
    return new Promise((resolve, reject) => {
      const server = net.createServer();
      server.listen(0, () => {
        const addr = server.address();
        if (addr && typeof addr === "object") {
          const port = addr.port;
          server.close(() => resolve(port));
        } else {
          server.close(() => reject(new Error("Could not get port")));
        }
      });
      server.on("error", reject);
    });
  }

  /**
   * Start the WebSocket server on the given port
   */
  async start(port: number): Promise<void> {
    this.wss = new WebSocketServer({ port });

    this.wss.on("connection", (ws) => {
      ws.on("message", (data) => {
        try {
          const msg = JSON.parse(data.toString()) as WsClientMessage;
          this.handleClientMessage(ws, msg);
        } catch {
          // Ignore malformed messages
        }
      });

      ws.on("close", () => {
        // Find and remove the disconnected client
        for (const [name, client] of this.clients) {
          if (client === ws) {
            this.clients.delete(name);
            this.agents = this.agents.filter((a) => a.name !== name);
            this.broadcast({ type: "agent_left", agent: name });
            // Notify coordinator about agent leaving
            if (this.onAgentLeaveCallback) {
              this.onAgentLeaveCallback(name);
            }
            break;
          }
        }
      });
    });
  }

  /**
   * Stop the WebSocket server
   */
  stop(): void {
    if (this.wss) {
      this.wss.close();
      this.wss = null;
    }
    this.clients.clear();
  }

  /**
   * Register a callback for incoming messages
   */
  onMessage(callback: (msg: PipMessage) => void): void {
    this.onMessageCallback = callback;
  }

  /**
   * Register a callback for when agents join
   */
  onAgentJoin(callback: (agent: AgentInfo) => void): void {
    this.onAgentJoinCallback = callback;
  }

  /**
   * Register a callback for when agents leave
   */
  onAgentLeave(callback: (agentName: string) => void): void {
    this.onAgentLeaveCallback = callback;
  }

  /**
   * Send a message to a specific agent
   */
  sendTo(agentName: string, payload: PipMessage): boolean {
    const client = this.clients.get(agentName);
    if (client && client.readyState === WebSocket.OPEN) {
      const msg: WsServerMessage = { type: "message", payload };
      client.send(JSON.stringify(msg));
      return true;
    }
    return false;
  }

  /**
   * Broadcast a message to all connected clients
   */
  private broadcast(msg: WsServerMessage): void {
    const data = JSON.stringify(msg);
    for (const [, client] of this.clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(data);
      }
    }
  }

  /**
   * Handle incoming messages from clients
   */
  private handleClientMessage(ws: WebSocket, msg: WsClientMessage): void {
    switch (msg.type) {
      case "register": {
        this.clients.set(msg.agent.name, ws);

        // Add to agents list if not already present
        if (!this.agents.find((a) => a.name === msg.agent.name)) {
          const agentInfo: AgentInfo = {
            name: msg.agent.name,
            pid: msg.agent.pid,
            startedAt: Date.now(),
            isCoordinator: false,
            cwd: "",
          };
          this.agents.push(agentInfo);
          this.broadcast({ type: "agent_joined", agent: agentInfo });
          // Notify coordinator about new agent
          if (this.onAgentJoinCallback) {
            this.onAgentJoinCallback(agentInfo);
          }
        }

        // Send current registry to the new client
        const registryMsg: WsServerMessage = {
          type: "registry",
          agents: this.agents,
        };
        ws.send(JSON.stringify(registryMsg));
        break;
      }

      case "message": {
        // Route message to target agent
        const targetClient = this.clients.get(msg.to);
        if (targetClient && targetClient.readyState === WebSocket.OPEN) {
          const broadcastMsg: WsServerMessage = {
            type: "message",
            payload: msg.payload,
          };
          targetClient.send(JSON.stringify(broadcastMsg));
        }

        // Also notify local callback (coordinator's own handler)
        if (this.onMessageCallback) {
          this.onMessageCallback(msg.payload);
        }
        break;
      }

      case "heartbeat": {
        // Keep-alive, no action needed
        break;
      }
    }
  }
}
