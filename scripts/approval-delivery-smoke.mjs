import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { SourceTextModule, SyntheticModule } from "node:vm";
import { setImmediate as nextTurn } from "node:timers/promises";
import ts from "typescript";

// Exercise the real registered tool and receiver callback without real agent data.
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const agents = ["approver", "worker"];
const buses = new Map();
const widgets = new Map();
let mode = "default";
let transportStatus = "live";
let hasUI = true;

class MemoryBus {
  constructor(name) { this.name = name; buses.set(name, this); }
  onMessage(handler) { this.receive = handler; }
  onStatusChange() {}
  onLiveAgentsChange() {}
  async init() { return this.name === "approver" ? "coordinator" : "worker"; }
  getStatus() { return transportStatus; }
  getLiveAgents() { return agents.map(name => ({ name })); }
  isMessageQueued() { return false; }
  setLocalActivity() {}
  shutdown() { buses.delete(this.name); }
  sendMessage(to, content, type, metadata = {}) {
    const msg = { id: crypto.randomUUID(), from: this.name, to, content, type, timestamp: Date.now(), read: false, ...metadata };
    const target = buses.get(to);
    assert.ok(target, `missing adapter recipient ${to}`);
    target.receive(msg);
    return msg;
  }
}

class MemoryWidget {
  constructor(name) { this.inbox = []; this.pending = 0; widgets.set(name, this); }
  syncFromDisk() {}
  addMessage(msg) { this.inbox.push(msg); }
  setCoordinatorPendingCount(count) { this.pending = count; }
  setCoordinatorInboxMode() {}
  updateAgentsWidget() {}
  hideAll() {}
}

const registry = {
  ensurePip2pDirs: () => false,
  ensureGitignore() {},
  ensureAgentInbox() {},
  addAgent() {},
  removeAgent() {},
  removeServerInfo() {},
  getCoordinator: () => ({ name: "approver" }),
  getAgentByPid: () => undefined,
  readServerInfo: () => ({ coordinator: "approver" }),
  ensureProjectSettings() {},
  readProjectSettings: () => ({ coordinatorInboxDeliveryMode: mode }),
  setCoordinatorInboxDeliveryMode: (_cwd, value) => { mode = value; },
  getOtherAgents: (_cwd, self) => agents.filter(name => name !== self).map(name => ({ name })),
};

const modules = new Map();
function synthetic(id, exports) {
  return new SyntheticModule(Object.keys(exports), function () {
    for (const [key, value] of Object.entries(exports)) this.setExport(key, value);
  }, { identifier: id });
}
async function load(id) {
  if (modules.has(id)) return modules.get(id);
  let mod;
  if (id === resolve(root, "src/message-bus.ts")) mod = synthetic(id, { MessageBus: MemoryBus });
  else if (id === resolve(root, "src/widget-manager.ts")) mod = synthetic(id, { WidgetManager: MemoryWidget });
  else if (id === resolve(root, "src/agent-registry.ts")) mod = synthetic(id, registry);
  else if (!id.startsWith(root + "/src/")) mod = synthetic(id, await import(id));
  else {
    const source = await readFile(id, "utf8");
    const { outputText } = ts.transpileModule(source, {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
      fileName: id,
    });
    mod = new SourceTextModule(outputText, { identifier: id });
  }
  modules.set(id, mod);
  return mod;
}
const extension = await load(resolve(root, "src/index.ts"));
await extension.link((specifier, parent) => load(specifier.startsWith(".")
  ? resolve(dirname(parent.identifier), specifier.replace(/\.js$/, ".ts"))
  : specifier));
await extension.evaluate();

async function start(name) {
  const events = new Map();
  const commands = new Map();
  const tools = new Map();
  const injected = [];
  const state = { idle: true, pending: false };
  const ctx = {
    cwd: "/isolated-pip2p-probe",
    hasUI,
    isIdle: () => state.idle,
    hasPendingMessages: () => state.pending,
    ui: { input: async () => name, notify() {}, setWidget() {} },
  };
  extension.namespace.default({
    on(event, handler) { events.set(event, [...(events.get(event) ?? []), handler]); },
    registerCommand(command, definition) { commands.set(command, definition); },
    registerTool(tool) { tools.set(tool.name, tool); },
    sendUserMessage(message) { injected.push(message); },
    sendMessage() { throw new Error("unexpected skill dispatch"); },
  });
  await commands.get("pip2p").handler("start", ctx);
  return {
    injected, state, tools, widget: widgets.get(name),
    async endTurn() {
      for (const handler of events.get("agent_end") ?? []) await handler({}, ctx);
      // The production handler schedules its drain with setTimeout(..., 0).
      await new Promise(resolve => setTimeout(resolve, 0));
      await nextTurn();
    },
    async stop() { await commands.get("pip2p").handler("stop", ctx); },
  };
}

const scenarios = [
  { name: "control: idle response auto-injects", mode: "auto-inject", busy: false, response: true },
  { name: "control: busy response queues then injects", mode: "auto-inject", busy: true, response: true },
  { name: "inbox mode retains approval without injection", mode: "default", busy: false },
  { name: "auto-inject mode injects approval instead of inbox", mode: "auto-inject", busy: false },
  { name: "busy auto-inject queues approval then injects on idle", mode: "auto-inject", busy: true },
  { name: "pending host message defers approval until idle", mode: "auto-inject", busy: true, hostPending: true },
  { name: "worker retains approval in inbox", mode: "auto-inject", busy: false, recipient: "worker" },
  { name: "file mode retains approval in inbox", mode: "auto-inject", busy: false, status: "file" },
  { name: "non-UI host retains approval in inbox", mode: "auto-inject", busy: false, hasUI: false },
];
let failures = 0;
for (const scenario of scenarios) {
  mode = scenario.mode;
  transportStatus = scenario.status ?? "live";
  hasUI = scenario.hasUI ?? true;
  const recipient = scenario.recipient ?? "approver";
  const approver = await start(recipient);
  const worker = await start(recipient === "approver" ? "worker" : "approver");
  try {
    approver.state.idle = scenario.hostPending ? true : !scenario.busy;
    approver.state.pending = scenario.hostPending ?? false;
    const result = scenario.response
      ? await worker.tools.get("reply_to_agent").execute("probe", {
        to: recipient, message: "Response control probe",
      })
      : await worker.tools.get("request_approval_from_agent").execute("probe", {
        to: recipient, actionType: "local-probe", title: "Approve local probe",
        summary: "Routing probe only; no action is performed.",
        details: "Approval context must survive injection.",
        commands: ["echo local-probe"], files: ["probe-fixture.txt"],
      });
    assert.ok(result.details.messageId, "tool must send a message");
    if (!scenario.response) assert.ok(result.details.requestId, "tool must create structured approval request");
    const auto = scenario.mode === "auto-inject" && recipient === "approver"
      && hasUI && transportStatus === "live";
    const observed = {
      injected: approver.injected.length,
      inbox: approver.widget.inbox.length,
      pending: approver.widget.pending,
    };
    console.log(`${scenario.name}: ${JSON.stringify(observed)}`);
    assert.deepEqual(observed, {
      injected: auto && !scenario.busy ? 1 : 0,
      inbox: auto ? 0 : 1,
      pending: auto && scenario.busy ? 1 : 0,
    });
    if (auto && scenario.busy) {
      approver.state.idle = true;
      approver.state.pending = false;
      await approver.endTurn();
      assert.equal(approver.injected.length, 1);
      assert.equal(approver.widget.pending, 0);
      assert.equal(approver.widget.inbox.length, 0);
    }
    if (auto) {
      assert.match(approver.injected[0], scenario.response
        ? /response.*Response control probe/s
        : /approval-request.*Approve local probe/s);
      assert.match(approver.injected[0], /stop and wait for your user's direction/);
      if (!scenario.response) {
        for (const value of [result.details.requestId, "local-probe",
          "Approval context must survive injection.", "echo local-probe", "probe-fixture.txt"]) {
          assert.ok(approver.injected[0].includes(value), `injected approval must include ${value}`);
        }
      }
    } else if (!scenario.response) {
      assert.equal(approver.widget.inbox[0].approvalRequest.requestId, result.details.requestId);
    }
    console.log(`PASS ${scenario.name}`);
  } catch (error) {
    failures++;
    console.error(`FAIL ${scenario.name}: ${error.message}`);
  } finally {
    await worker.stop();
    await approver.stop();
  }
}
assert.equal(buses.size, 0, "all adapter agents must be stopped");
console.log(`${scenarios.length - failures}/${scenarios.length} scenarios passed; active adapter agents: ${buses.size}`);
process.exitCode = failures ? 1 : 0;
