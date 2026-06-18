# pip2p

Peer-to-peer multi-agent communication extension for [pi](https://github.com/earendil-works/pi) and [oh-my-pi (omp)](https://github.com/can1357/oh-my-pi). Enable multiple agent instances to communicate directly with each other in real-time.

## Features

- **Real-time messaging** - WebSocket-based communication with automatic file fallback
- **Coordinator/Worker architecture** - First agent becomes coordinator, others connect as workers
- **Automatic failover** - If coordinator dies, a worker automatically takes over
- **Asynchronous agent workflow** - Receivers auto-run incoming work while senders complete their turn immediately and read replies later from inbox
- **Structured skill invocation** - Ask another agent to run a local skill with interactive or auto inbox-delivered replies
- **Widget integration** - Live inbox notifications and agent status in your terminal
- **Project-scoped** - Each project has its own isolated agent network
## Installation

### Prerequisites

- [pi](https://github.com/earendil-works/pi) **or** [omp](https://github.com/can1357/oh-my-pi) installed
- Node.js 18+
- pnpm

### Setup

1. Clone or download this repository:

```bash
git clone https://github.com/tk-425/pip2p.git
cd pip2p
```

2. Install dependencies:

```bash
pnpm install
```

3. Build the extension:

```bash
pnpm run build
```

4. Install the extension:

```bash
# For pi:
ln -s "$(pwd)" ~/.pi/agent/extensions/pip2p

# For omp:
omp plugin link "$(pwd)"
```

5. Verify installation:

```bash
# pi:
ls -la ~/.pi/agent/extensions/pip2p

# omp:
omp plugin list
```

## Usage

Start multiple instances in the same project directory. pip2p is inactive by default, so start each agent normally and then opt in with `/pip2p`:

```bash
# Terminal 1 (pi or omp)
pi    # or: omp
/pip2p
# Enter: alice

# Terminal 2 (pi or omp)
pi    # or: omp
/pip2p
# Enter: bob

# Terminal 3 (pi or omp)
pi    # or: omp
/pip2p
# Enter: carol
```

The first agent becomes the coordinator, and subsequent agents join as workers.

Once activated, pip2p persists across `/new`, `/resume`, and `/fork` for that session.

### pip2p Session Commands

Use the slash command to manage pip2p in the current session:

```bash
/pip2p         # Start pip2p, or show current status if already active
/pip2p start   # Same as /pip2p
/pip2p status  # Show whether pip2p is active and current role/mode
/pip2p stop    # Leave the pip2p network for this session
```

### Sending Messages And Invoking Skills

Use the provided tools to communicate:

```
# Send a task to another agent
send_to_agent --to bob --message "Please refactor the auth module"

# Send a general message to another agent
send_to_agent --to bob --message "Hello Bob!" --type message

# Invoke a local skill on another agent (interactive by default)
invoke_skill_on_agent --to bob --skill devflow-commit

# Invoke a one-shot skill and deliver the final result to the inbox
invoke_skill_on_agent --to bob --skill firecrawl --args "search latest Tesla stock price" --reply-mode auto

# Check your inbox later for replies/results
get_inbox

# Reply to a specific message
reply_to_agent --to alice --message "Done! PR is ready" --in-reply-to msg-123

# List all active agents
list_agents
```

Workflow contract:

1. **Alice sends** Bob a task, message, skill invocation, or approval response
2. **Bob auto-runs immediately** for tasks/messages/skill invocations — no manual inbox check required on Bob
3. **Alice does not wait in the same turn** — Alice finishes her current turn instead of polling for Bob
4. **Bob sends replies/results back to Alice's inbox** with pip2p reply tools
5. **Structured approval decisions resume Bob directly** rather than appearing as a normal inbox message on Bob

### How It Works

1. **First agent** (alice) starts as coordinator and launches a WebSocket server
2. **Subsequent agents** (bob, carol) connect to the coordinator's server
3. **Messages flow** through the coordinator in real-time
4. **File fallback** activates automatically if WebSocket connection fails
5. **Widgets display** inbox status and connected agents in your terminal

## Architecture

### Connection Modes

- **Live mode** (🟢) - WebSocket connection active, real-time messaging
- **File mode** (🟡) - Using file-based IPC as fallback

### Message Types

- **task** - Work delegation (auto-injected for immediate processing on the receiving agent)
- **message** - General communication (also auto-injected for immediate processing on the receiving agent)
- **response** - Replies and results (shown in the recipient's inbox widget only)
- **approval-request** - Structured approval requests (shown in the approver's inbox widget only)
- **approval-decision** - Structured approval approvals/rejections (delivered directly to the waiting agent and not shown as a normal inbox message)

### Skill Invocation Modes

`invoke_skill_on_agent` supports two reply modes, and both deliver replies to the sender's inbox:

- **interactive** (default) — best for skills that ask follow-up questions, request confirmation, or need multiple turns. Follow-up replies and final results arrive in the inbox.
- **auto** — best for one-shot skills. The final result arrives in the inbox when complete.

Examples:

```bash
# Default interactive mode
invoke_skill_on_agent --to bob --skill devflow-commit

# Explicit interactive mode
invoke_skill_on_agent --to bob --skill devflow-commit --reply-mode interactive

# Explicit auto mode
invoke_skill_on_agent --to bob --skill firecrawl --args "search latest Apple stock price" --reply-mode auto
```

### Approval Workflow

When delegated work on Bob needs approval:

1. **Bob sends Alice a structured approval request** with `request_approval_from_agent`
2. **Alice reviews the request from inbox** and responds with `respond_to_approval_request`
3. **Bob can also resolve the same request locally** with `resolve_local_approval`
4. **First approval wins** — whichever valid approval or rejection arrives first resolves the request
5. **Approval decisions resume Bob directly**; they do not appear as a normal inbox message on Bob

### OMP Project-Local Skill Resolution

For OMP cross-agent skill invocation, pip2p uses the project-local skill path:

```bash
.agents/skills/<skill-name>/SKILL.md
```

That lets OMP receive skill invocations through its native `skill-prompt` path while preserving the existing pi behavior.
### Project Structure

```
your-project/
├── .pip2p/
│   ├── agents.json       # Registered agents
│   ├── server.json       # Coordinator server info
│   └── inbox/
│       ├── alice/        # Alice's messages
│       ├── bob/          # Bob's messages
│       └── carol/        # Carol's messages
└── your-project-files/
```

## Tools

### send_to_agent

Send a message or task to another agent. The receiving agent auto-runs it immediately. After sending, do not wait in the same turn; read replies later from inbox.

If pip2p is inactive in the current session, run `/pip2p` first.

```bash
send_to_agent --to <agent-name> --message "<content>" [--type task|message]
```

### get_inbox

Retrieve messages from your inbox. Use this to read replies that already arrived. Do not call it immediately after sending or invoking another agent unless you explicitly want to check messages right away.

```bash
get_inbox [--from <agent-name>]
```

### reply_to_agent

Reply to a specific message with threading support. Use this for explicit replies/results that should go to the recipient's inbox.

```bash
reply_to_agent --to <agent-name> --message "<content>" --in-reply-to <message-id>
```

### request_approval_from_agent

Send a structured approval request to another agent and track it locally until the first approval or rejection arrives.

```bash
request_approval_from_agent --to <agent-name> --actionType "<type>" --title "<short title>" --summary "<summary>"
```

### respond_to_approval_request

Approve or reject a structured approval request from another agent. The decision is delivered directly back to the waiting agent and resumes the delegated workflow.

```bash
respond_to_approval_request --to <agent-name> --requestId <request-id> --decision approved|rejected [--note "<note>"]
```

### resolve_local_approval

Resolve a locally pending approval request from the current session. This supports first-approval-wins when the local user approves before the remote agent responds.

```bash
resolve_local_approval --requestId <request-id> --decision approved|rejected [--note "<note>"]
```

### list_agents

Show all active agents and connection status.

```bash
list_agents
```

### invoke_skill_on_agent

Invoke a local skill on another agent. The target agent auto-runs it immediately. The sender should finish the current turn and read follow-up replies or final results later from inbox.

```bash
invoke_skill_on_agent --to <agent-name> --skill <skill-name> [--args "<skill args>"] [--reply-mode interactive|auto]
```

For delegated skill runs, pip2p injects a delegated-run preamble so the receiving agent knows:
- who invoked the skill
- that replies/results should go back to the invoker's inbox with `reply_to_agent`
- that approval should use `request_approval_from_agent`
- that approval decisions resume the workflow directly rather than through inbox polling

## Configuration

### Environment Variables

- `PIP2P_PORT` - Override default port range (default: 7000-7100)
- `PIP2P_TIMEOUT` - Connection timeout in milliseconds (default: 5000)

### Extension Settings

Configure in `~/.pi/config.json`:

```json
{
  "extensions": {
    "pip2p": {
      "autoConnect": true,
      "maxReconnectAttempts": 5,
      "heartbeatInterval": 30000
    }
  }
}
```

## Development

### Project Structure

```
pip2p/
├── src/
│   ├── index.ts           # Extension entry point
│   ├── server.ts          # WebSocket server (coordinator)
│   ├── client.ts          # WebSocket client (worker)
│   ├── message-bus.ts     # Message routing
│   ├── agent-registry.ts  # Agent tracking
│   ├── file-watcher.ts    # File-based fallback
│   ├── widget-manager.ts  # UI widgets
│   ├── skill-detect.ts    # Smart reply detection
│   └── types.ts           # TypeScript types
├── package.json
├── tsconfig.json
└── README.md
```

### Build

```bash
pnpm run build
```

### Watch Mode

```bash
pnpm run watch
```

### Testing

Start two instances (pi or omp) and test messaging:

```bash
# Terminal 1
pi    # or: omp
/pip2p
# Enter: alice

# Terminal 2
pi    # or: omp
/pip2p
# Enter: bob

# In alice's terminal, send a message
send_to_agent --to bob --message "Hello Bob!" --type message

# Expected:
# - Bob auto-runs immediately
# - Alice does not wait in the same turn
# - Bob replies back later
# - Alice reads the reply with: get_inbox
```

## Troubleshooting

### Agents can't connect

- Ensure all agents are in the same project directory
- Check if port 7000-7100 is available
- Verify installation:
  - pi: `ls -la ~/.pi/agent/extensions/pip2p`
  - omp: `omp plugin list`

### Messages not delivered

- Check connection mode (should be 🟢 Live)
- Verify agent names are correct
- Check `.pip2p/agents.json` for registered agents

### pip2p is inactive in this session

If a pip2p tool says the session is inactive, start pip2p first:

```bash
/pip2p
```

Then enter an agent name and retry the tool.

### Skill invocation and delegated approval behavior

- **pi** - Structured cross-agent skill invocation works. Interactive and auto replies are delivered to the invoker's inbox, and delegated approval decisions resume the worker directly.
- **omp** - Structured cross-agent skill invocation also works. For OMP, pip2p resolves project-local skills from `.agents/skills/<name>/SKILL.md`, dispatches them through OMP's native skill-prompt path, and uses the same direct delegated approval resume behavior as pi.

### Extension not loading

- Rebuild: `pnpm run build`
- Reinstall:
  - pi: `rm ~/.pi/agent/extensions/pip2p && ln -s "$(pwd)" ~/.pi/agent/extensions/pip2p`
  - omp: `omp plugin uninstall pip2p && omp plugin link "$(pwd)"`
- Check logs for errors

## License

MIT

## Contributing

Contributions welcome! Please open an issue or PR.
