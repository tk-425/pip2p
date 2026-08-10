/**
 * Standalone WebSocket server runner for pip2p.
 *
 * Spawned as a detached child process by the coordinator's extension.
 * Survives /new, /resume, /fork so the P2P network stays alive.
 *
 * Usage: node server-runner.mjs --cwd <dir> --coordinator <name> --coordinator-pid <pid>
 *
 * Shutdown:
 *   - SIGTERM or SIGINT → clean shutdown
 *   - If coordinator PID dies → shutdown after a short grace period
 */

import { WebSocketServer } from "ws";
import * as net from "node:net";
import * as fs from "node:fs";
import * as path from "node:path";

// --- Parse args ---
const args = process.argv.slice(2);
function getArg(name) {
  const idx = args.indexOf(`--${name}`);
  if (idx === -1 || idx + 1 >= args.length) return undefined;
  return args[idx + 1];
}

const cwd = getArg("cwd");
const coordinator = getArg("coordinator");
const coordinatorPid = parseInt(getArg("coordinator-pid") || "0", 10);

if (!cwd || !coordinator || !coordinatorPid) {
  console.error("[pip2p-server] Missing required args: --cwd, --coordinator, --coordinator-pid");
  process.exit(1);
}

// --- State ---
let wss = null;
const clients = new Map(); // name → WebSocket
const agents = [];
let shuttingDown = false;

// --- Helpers ---
async function findFreePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, () => {
      const addr = s.address();
      if (addr && typeof addr === "object") {
        const port = addr.port;
        s.close(() => resolve(port));
      } else {
        s.close(() => reject(new Error("Could not get port")));
      }
    });
    s.on("error", reject);
  });
}

function broadcast(msg) {
  const data = JSON.stringify(msg);
  for (const [, client] of clients) {
    if (client.readyState === 1) { // WebSocket.OPEN
      client.send(data);
    }
  }
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function getServerFilePath() {
  return path.join(cwd, ".pip2p", "server.json");
}

function writeServerInfo(port) {
  const pip2pDir = path.join(cwd, ".pip2p");
  if (!fs.existsSync(pip2pDir)) {
    fs.mkdirSync(pip2pDir, { recursive: true });
  }
  fs.writeFileSync(getServerFilePath(), JSON.stringify({
    port,
    coordinator,
    pid: process.pid,
    startedAt: Date.now(),
  }, null, 2));
}

function removeServerInfo() {
  const filePath = getServerFilePath();
  if (fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
  }
}

// --- Server ---
async function start() {
  const port = await findFreePort();

  wss = new WebSocketServer({ port });

  wss.on("connection", (ws) => {
    ws.on("message", (data) => {
      try {
        const msg = JSON.parse(data.toString());
        handleClientMessage(ws, msg);
      } catch {
        // Ignore malformed messages
      }
    });

    ws.on("close", () => {
      for (const [name, client] of clients) {
        if (client === ws) {
          clients.delete(name);
          const idx = agents.findIndex((a) => a.name === name);
          if (idx !== -1) agents.splice(idx, 1);
          broadcast({ type: "agent_left", agent: name });
          break;
        }
      }
    });
  });

  writeServerInfo(port);
  console.log(`[pip2p-server] Listening on port ${port}, coordinator: ${coordinator}`);

  // Start coordinator PID health check
  startHealthCheck();
}

function handleClientMessage(ws, msg) {
  switch (msg.type) {
    case "register": {
      clients.set(msg.agent.name, ws);

      if (!agents.find((a) => a.name === msg.agent.name)) {
        const agentInfo = {
          name: msg.agent.name,
          pid: msg.agent.pid,
          startedAt: Date.now(),
          isCoordinator: msg.agent.name === coordinator,
          cwd: "",
          activity: "unknown",
        };
        agents.push(agentInfo);
        broadcast({ type: "agent_joined", agent: agentInfo });
      }

      // Send current registry to the new client
      ws.send(JSON.stringify({ type: "registry", agents }));
      break;
    }

    case "message": {
      const targetClient = clients.get(msg.to);
      if (targetClient && targetClient.readyState === 1) {
        targetClient.send(JSON.stringify({ type: "message", payload: msg.payload }));
      }
      break;
    }

    case "set_activity": {
      const agent = agents.find((a) => a.name === msg.agent);
      if (agent) {
        agent.activity = msg.activity;
        broadcast({ type: "activity_changed", agent: msg.agent, activity: msg.activity });
      }
      break;
    }

    case "heartbeat": {
      // Keep-alive, no action needed
      break;
    }
  }
}

// --- Health check: shut down if coordinator process dies ---
function startHealthCheck() {
  let deathCount = 0;
  setInterval(() => {
    if (isProcessAlive(coordinatorPid)) {
      deathCount = 0;
    } else {
      deathCount++;
      if (deathCount >= 3) {
        console.log("[pip2p-server] Coordinator process dead, shutting down");
        shutdown();
      }
    }
  }, 2000);
}

function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log("[pip2p-server] Shutting down");
  removeServerInfo();
  if (wss) {
    wss.close();
    wss = null;
  }
  process.exit(0);
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

start().catch((err) => {
  console.error("[pip2p-server] Failed to start:", err);
  process.exit(1);
});
