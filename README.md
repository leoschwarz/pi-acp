# pi-acp

ACP ([Agent Client Protocol](https://agentclientprotocol.com/overview/introduction)) adapter for [`pi`](https://github.com/earendil-works/pi) coding agent.

`pi-acp` communicates **ACP JSON-RPC 2.0 over stdio** to an ACP client (e.g. Zed editor) and spawns `pi --mode rpc`, bridging requests/events between the two.

## Contents

- [Status](#status)
- [How it works](#how-it-works)
- [Features](#features)
- [Prerequisites](#prerequisites)
- [Install](#install)
- [Configuration](#configuration)
- [File delegation](#file-delegation)
- [Session lifecycle](#session-lifecycle)
- [Slash commands](#slash-commands)
- [Authentication](#authentication)
- [Development](#development)
- [Limitations](#limitations)
- [License](#license)

## Status

This is an MVP-style adapter intended to be useful today and easy to iterate on. Some ACP features may be not implemented or are not supported (see [Limitations](#limitations)). Development is centered around [Zed](https://zed.dev) editor support; other clients may have varying levels of compatibility.

Expect some minor breaking changes.

## How it works

- One ACP session maps to one dedicated `pi --mode rpc` subprocess.
- `session/new` spawns the subprocess, `session/prompt` forwards the prompt to pi, and pi's streaming events are translated into ACP `session/update` notifications.
- `session/cancel` aborts the in-flight pi turn.

## Features

- Streams assistant output as ACP `agent_message_chunk`
- Maps pi tool execution to ACP `tool_call` / `tool_call_update`
  - Tool call locations are surfaced for ACP clients that support opening the referenced file/context
  - Relative file paths from pi are resolved against the session cwd before being emitted as ACP tool locations, which enables follow-along features in clients like Zed
  - For `edit`, `pi-acp` attempts to infer a 1-based line number from a unique `oldText` match in the pre-edit file snapshot and includes it in the emitted tool location when possible
  - For `edit`, `pi-acp` snapshots the file before the tool runs and emits an ACP **structured diff** (`oldText`/`newText`) on completion when possible
- Session persistence
  - pi stores its own sessions in `~/.pi/agent/sessions/...`
  - `pi-acp` stores a small mapping file at `~/.pi/pi-acp/session-map.json` so `session/load` can reattach to a previous pi session file
- Slash commands (see [Slash commands](#slash-commands))
  - Loads file-based slash commands compatible with pi's conventions
  - Adds a small set of built-in commands for headless/editor usage
  - Supports skill commands (if enabled in pi settings, they appear as `/skill:skill-name` in the ACP client)
- Skills are loaded by pi directly and are available in ACP sessions
- (Zed) Emits a "startup info" block into the session (pi version, context, skills, prompts, extensions — similar to `pi` in the terminal). Disable it by setting `quietStartup: true` in pi settings (`~/.pi/agent/settings.json` or `<project>/.pi/settings.json`). When `quietStartup` is enabled, `pi-acp` will still emit a "new version available" message if the installed pi version is outdated.
- (Zed) Session history is supported in Zed starting with [`v0.225.0`](https://zed.dev/releases/preview/0.225.0). Session loading / history maps to pi's session files. Sessions can be resumed both in `pi` and in the ACP client.
- File-tool delegation to the ACP client (see [File delegation](#file-delegation))

## Prerequisites

- Node.js 22+
- [`pi`](https://github.com/earendil-works/pi) v0.80.4+ installed and available on your `PATH` (the adapter runs the `pi` executable):

  ```bash
  npm install -g @earendil-works/pi-coding-agent
  ```

- Configure `pi` separately for your model providers/API keys

## Install

### Zed via the ACP Registry

In Zed, launch the registry with the `zed: acp registry` command and select the `pi ACP` adapter from the list. This adds the agent server configuration to your `settings.json` and keeps it up to date:

```json
"agent_servers": {
  "pi-acp": {
    "type": "registry"
  }
}
```

### Zed via npx (no global install, always latest version)

```json
"agent_servers": {
  "pi": {
    "type": "custom",
    "command": "npx",
    "args": ["-y", "pi-acp"],
    "env": {}
  }
}
```

### Zed via global install

```bash
npm install -g pi-acp
```

```json
"agent_servers": {
  "pi": {
    "type": "custom",
    "command": "pi-acp",
    "args": [],
    "env": {}
  }
}
```

### From source

```bash
npm install
npm run build
```

Point your ACP client to the built `dist/index.js`:

```json
"agent_servers": {
  "pi": {
    "type": "custom",
    "command": "node",
    "args": ["/path/to/pi-acp/dist/index.js"],
    "env": {}
  }
}
```

Other ACP clients: any client that supports custom ACP agent servers can launch `pi-acp` the same way (command + args over stdio).

## Configuration

Environment variables (set them in the `env` block of your agent server config):

- `PI_ACP_PI_COMMAND` — path or command used to launch pi instead of the default `pi` on your `PATH`. Useful for development/testing against a local pi build.
- `PI_ACP_ENABLE_EMBEDDED_CONTEXT` — set to `false` to opt out of ACP `promptCapabilities.embeddedContext` support. When disabled, compliant ACP clients should avoid sending embedded `resource` blocks; if they send them anyway, `pi-acp` degrades gracefully by converting them into plain-text prompt context. Default: embedded context is advertised.
- `PI_ACP_ALLOW_MULTIPLE_SESSIONS` — set to `true` to keep several sessions (pi subprocesses) alive per ACP connection. Default: only the most recently created or loaded session stays alive; previously spawned sessions of the same connection are closed automatically (their history remains on disk and can be re-opened from the session picker).
- `PI_ACP_FS_DELEGATE` — set to `false` to disable client-side file-tool delegation (see [File delegation](#file-delegation)); pi then reads/writes files locally. Default: delegation is used whenever the client advertises the ACP `fs.readTextFile` / `fs.writeTextFile` capabilities.
- `PI_ACP_FS_DELEGATE_EXTENSION` — overrides the path of the bundled pi extension used for file delegation (development/testing).

Example: turn delegation off for a particular agent server:

```json
"agent_servers": {
  "pi": {
    "type": "custom",
    "command": "pi-acp",
    "args": [],
    "env": { "PI_ACP_FS_DELEGATE": "false" }
  }
}
```

## File delegation

When the client advertises the ACP `fs` capabilities (Zed does), `pi-acp` spawns pi with a bundled extension that overrides pi's built-in `read`, `write`, and `edit` tools. Their executions are routed through the adapter to the client (`fs/read_text_file` / `fs/write_text_file`) instead of hitting the disk directly:

- **Reviewable edits**: the client performs the actual write through its own buffer machinery, so changes show up in the editor's review UI (in Zed: the "edited files" area with diff + accept/reject).
- **Unsaved buffer visibility**: reads go through the editor, so the agent sees unsaved changes in open buffers.
- **Tool-call diffs**: `pi-acp` still emits structured ACP diffs for delegated writes/edits from the tool result details.

Notes and limits:

- Image files are still read locally (ACP file reads are text-only), so image support keeps working.
- Directory creation happens locally before a delegated write (ACP has no mkdir); deletions (bash `rm` etc.) remain local and are not tracked by the client.
- `bash` is not delegated; commands run locally in pi as before.

## Session lifecycle

`pi-acp` advertises the ACP `sessionCapabilities.close`, `sessionCapabilities.resume`, and (unstable) `sessionCapabilities.fork` capabilities:

- `session/close` cancels any ongoing work and stops the pi subprocess for that session, so clients can release resources explicitly. Closing a session that isn't running is a no-op.
- `session/resume` re-attaches to a stored session without replaying its message history (unlike `session/load`). If the session is already live, the running subprocess is reused.
- `session/fork` branches a session into a new independent one (pi `clone`, i.e. a copy of the full conversation). The fork takes over the running pi subprocess; the source session stays on disk and is re-spawned lazily when used again. Forking is rejected while a turn is running or queued.

## Slash commands

### 1) File-based commands (aka prompts)

Loaded from:

- User commands: `~/.pi/agent/prompts/**/*.md`
- Project commands: `<cwd>/.pi/prompts/**/*.md`

### 2) Built-in commands

- `/compact [instructions...]` — run pi compaction (optionally with custom instructions)
- `/autocompact on|off|toggle` — toggle automatic compaction
- `/export` — export the current session to HTML in the session `cwd`
- `/session` — show session stats (tokens/messages/cost/session file)
- `/name <name>` — set session display name
- `/steering all|one-at-a-time` — get/set pi steering message delivery mode (how queued steering messages are delivered)
- `/follow-up all|one-at-a-time` — get/set pi follow-up message delivery mode (how queued follow-up messages are delivered)
- `/changelog` — print the installed pi changelog (best-effort)

Commands that map to client-side UI instead:

- `/model` — not implemented (use the model selector UI in Zed)
- `/thinking` — maps to the 'mode' selector in Zed
- `/clear` — not implemented (use the ACP client 'new' command)

### 3) Skill commands

- Skill commands can be enabled in pi settings and will appear in the slash command list in the ACP client as `/skill:skill-name`.

**Note**: Slash commands provided by pi extensions are not currently supported.

## Authentication

This agent supports **Terminal Auth** for the [ACP Registry](https://agentclientprotocol.com/get-started/registry).
In Zed, this will show an **Authenticate** banner that launches pi in a terminal.
Launch pi in a terminal for interactive login/setup:

```bash
pi-acp --terminal-login
```

Your ACP client can also invoke this automatically based on the agent's advertised `authMethods`.

## Development

```bash
npm install
npm run dev        # run from src via tsx
npm run build
npm run typecheck
npm run lint
npm run test
npm run smoke      # ACP smoke test over stdio
```

Project layout:

- `src/acp/*` — ACP server + translation layer
- `src/pi-rpc/*` — pi subprocess wrapper (RPC protocol)
- `src/extension/*` — bundled pi extension for client-side file delegation
- `test/*` — unit and component tests

## Limitations

- ACP terminal delegation (`terminal/*`) is not implemented. pi executes `bash` locally; only file tools (`read`/`write`/`edit`) are delegated to the client when supported (see [File delegation](#file-delegation)). Deletions and shell effects are therefore not part of the client's review flow.
- MCP servers are accepted in ACP params and stored in session state, but not wired through to pi in this adapter. If you use [pi MCP adapter](https://github.com/nicobailon/pi-mcp-adapter) it will be available in the ACP client.
- Assistant streaming is currently sent as `agent_message_chunk` (no separate thought stream).
- Queue is implemented client-side and should work like pi's `one-at-a-time`.

## License

MIT (see [LICENSE](LICENSE)).
