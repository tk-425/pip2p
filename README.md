# pip2p

Peer-to-peer multi-agent communication extension for [pi](https://github.com/earendil-works/pi) and [oh-my-pi (omp)](https://github.com/can1357/oh-my-pi). Enable multiple agent instances to communicate directly with each other in real-time.

## Features

- **Real-time messaging** - WebSocket-based communication with automatic file fallback
- **Coordinator/Worker architecture** - First agent becomes coordinator, others connect as workers
- **Automatic failover** - If coordinator dies, a worker automatically takes over
- **Smart reply detection** - Prevents message loops by auto-detecting responses
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

Start multiple instances in the same project directory. Each will prompt for an agent name on startup:

```bash
# Terminal 1 (pi or omp)
pi    # or: omp
# When prompted, enter: alice

# Terminal 2 (pi or omp)
pi    # or: omp
# When prompted, enter: bob

# Terminal 3 (pi or omp)
pi    # or: omp
# When prompted, enter: carol
```

The first agent becomes the coordinator, and subsequent agents join as workers.

### Sending Messages

Use the provided tools to communicate:

```
# Send a task to another agent
send_to_agent --to bob --message "Please refactor the auth module"

# Check your inbox
get_inbox

# Reply to a specific message
reply_to_agent --to alice --message "Done! PR is ready" --in-reply-to msg-123

# List all active agents
list_agents
```

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

- **task** - Work delegation (auto-injected for immediate processing)
- **message** - General communication
- **response** - Replies (shown in inbox widget only)

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

Send a message or task to another agent.

```bash
send_to_agent --to <agent-name> --message "<content>" [--type task|message]
```

### get_inbox

Retrieve messages from your inbox.

```bash
get_inbox [--from <agent-name>]
```

### reply_to_agent

Reply to a specific message with threading support.

```bash
reply_to_agent --to <agent-name> --message "<content>" --in-reply-to <message-id>
```

### list_agents

Show all active agents and connection status.

```bash
list_agents
```

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
# When prompted, enter: alice

# Terminal 2
pi    # or: omp
# When prompted, enter: bob

# In alice's terminal, send a message
# Type: send a message to bob saying "Hello Bob!"

# In bob's terminal, check inbox
# Type: check my inbox
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
