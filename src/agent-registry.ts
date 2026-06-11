/**
 * Agent Registry - manages .pip2p/agents.json and .pip2p/server.json
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { AgentInfo, AgentRegistry, ServerInfo } from "./types.js";

const PIP2P_DIR = ".pip2p";
const AGENTS_FILE = "agents.json";
const SERVER_FILE = "server.json";

export function getPip2pDir(cwd: string): string {
  return path.join(cwd, PIP2P_DIR);
}

export function getInboxDir(cwd: string, agentName: string): string {
  return path.join(cwd, PIP2P_DIR, "inbox", agentName);
}

export function getAgentsFilePath(cwd: string): string {
  return path.join(cwd, PIP2P_DIR, AGENTS_FILE);
}

export function getServerFilePath(cwd: string): string {
  return path.join(cwd, PIP2P_DIR, SERVER_FILE);
}

export function ensurePip2pDirs(cwd: string): boolean {
  const pip2pDir = getPip2pDir(cwd);
  const inboxDir = path.join(pip2pDir, "inbox");

  // Check if directory already exists
  const alreadyExists = fs.existsSync(pip2pDir);

  // Create directories if they don't exist
  fs.mkdirSync(pip2pDir, { recursive: true });
  fs.mkdirSync(inboxDir, { recursive: true });

  return !alreadyExists;
}

export function ensureGitignore(cwd: string): void {
  const gitignorePath = path.join(cwd, ".gitignore");
  const pip2pEntry = ".pip2p/";

  // Read existing .gitignore or create empty array
  let lines: string[] = [];
  if (fs.existsSync(gitignorePath)) {
    const content = fs.readFileSync(gitignorePath, "utf-8");
    lines = content.split("\n");
  }

  // Check if .pip2p/ is already in .gitignore
  const hasPip2p = lines.some(line => line.trim() === pip2pEntry);

  if (!hasPip2p) {
    // Add .pip2p/ to .gitignore
    lines.push(pip2pEntry);
    fs.writeFileSync(gitignorePath, lines.join("\n"));
  }
}

export function ensureAgentInbox(cwd: string, agentName: string): void {
  const inboxDir = getInboxDir(cwd, agentName);
  fs.mkdirSync(inboxDir, { recursive: true });
}

// --- Agent Registry ---

export function readAgentRegistry(cwd: string): AgentRegistry {
  const filePath = getAgentsFilePath(cwd);
  if (!fs.existsSync(filePath)) {
    return { agents: [] };
  }
  const data = fs.readFileSync(filePath, "utf-8");
  return JSON.parse(data) as AgentRegistry;
}

export function writeAgentRegistry(cwd: string, registry: AgentRegistry): void {
  const filePath = getAgentsFilePath(cwd);
  ensurePip2pDirs(cwd);
  fs.writeFileSync(filePath, JSON.stringify(registry, null, 2));
}

export function addAgent(cwd: string, agent: AgentInfo): AgentRegistry {
  const registry = readAgentRegistry(cwd);
  // Remove existing entry with same name (if any)
  registry.agents = registry.agents.filter((a) => a.name !== agent.name);
  registry.agents.push(agent);
  writeAgentRegistry(cwd, registry);
  return registry;
}

export function removeAgent(cwd: string, agentName: string): AgentRegistry {
  const registry = readAgentRegistry(cwd);
  registry.agents = registry.agents.filter((a) => a.name !== agentName);
  writeAgentRegistry(cwd, registry);
  return registry;
}

export function getAgent(cwd: string, agentName: string): AgentInfo | undefined {
  const registry = readAgentRegistry(cwd);
  return registry.agents.find((a) => a.name === agentName);
}

export function getCoordinator(cwd: string): AgentInfo | undefined {
  const registry = readAgentRegistry(cwd);
  return registry.agents.find((a) => a.isCoordinator);
}

export function getOtherAgents(cwd: string, selfName: string): AgentInfo[] {
  const registry = readAgentRegistry(cwd);
  return registry.agents.filter((a) => a.name !== selfName);
}

// --- Server Info ---

export function readServerInfo(cwd: string): ServerInfo | null {
  const filePath = getServerFilePath(cwd);
  if (!fs.existsSync(filePath)) {
    return null;
  }
  const data = fs.readFileSync(filePath, "utf-8");
  return JSON.parse(data) as ServerInfo;
}

export function writeServerInfo(cwd: string, info: ServerInfo): void {
  const filePath = getServerFilePath(cwd);
  ensurePip2pDirs(cwd);
  fs.writeFileSync(filePath, JSON.stringify(info, null, 2));
}

export function removeServerInfo(cwd: string): void {
  const filePath = getServerFilePath(cwd);
  if (fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
  }
}

// --- PID-based Agent Lookup ---

export function getAgentByPid(cwd: string, pid: number): AgentInfo | undefined {
  const registry = readAgentRegistry(cwd);
  return registry.agents.find((a) => a.pid === pid);
}

// --- Last Agent Persistence (per-PID) ---
//
// Multiple agents share the same .pip2p/ directory, so we can't use a single
// .last-agent file. Instead we look up by PID from agents.json.
// The functions below are kept for backward compatibility but the PID-based
// lookup is preferred.

const LAST_AGENT_FILE = ".last-agent";

export function saveLastAgent(cwd: string, agentName: string): void {
  ensurePip2pDirs(cwd);
  const filePath = path.join(getPip2pDir(cwd), LAST_AGENT_FILE);
  fs.writeFileSync(filePath, agentName, "utf-8");
}

export function readLastAgent(cwd: string): string | null {
  const filePath = path.join(getPip2pDir(cwd), LAST_AGENT_FILE);
  if (!fs.existsSync(filePath)) return null;
  return fs.readFileSync(filePath, "utf-8").trim() || null;
}

export function isCoordinatorAlive(cwd: string): boolean {
  const serverInfo = readServerInfo(cwd);
  if (!serverInfo) return false;
  return isProcessAlive(serverInfo.pid);
}

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
