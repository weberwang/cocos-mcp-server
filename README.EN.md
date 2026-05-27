# Cocos Creator MCP Server Plugin

**[📖 English](README.EN.md)**  **[📖 中文](README.md)**

An MCP (Model Context Protocol) extension for Cocos Creator `3.8.6+`. It runs a local MCP service inside the editor and exposes scene, node, component, asset, prefab, debugging, and editor workflows to AI clients.

Current repository version: `v1.5.1`

## What This Repository Is

This repository is not a standalone desktop app. It is an editor extension meant to live under a Cocos Creator project's `extensions/` directory.

It has two runtime pieces:

- **Main extension**: runs inside the Cocos Creator extension environment, starts the HTTP MCP service, exposes tools, and manages panel settings / tool toggles.
- **stdio adapter**: proxies line-based JSON-RPC from `stdin` to the local HTTP `/mcp` endpoint, which makes it easy to connect `stdio`-oriented clients such as Codex or OpenCode.

## Current Capabilities

The code currently focuses on exposing editor behavior to AI clients in a stable way:

- **Scene and node operations**: inspect the current scene, read hierarchy, create nodes, move nodes, delete nodes, and update names / transforms / properties.
- **Component workflows**: add components, remove components, inspect component data, batch-update component properties, and normalize color / size-like inputs more reliably.
- **Prefab and asset workflows**: create prefabs, instantiate prefabs, create scene assets, import / move / delete assets, and inspect dependencies and metadata.
- **Editor and debugging features**: execute menu commands, undo / redo, inspect console logs, inspect project logs, validate scenes, query performance data, and capture screenshots.
- **Screenshot and view assistance**: supports editor, Scene View, and Game View screenshot capture with multiple fallback paths for blank-image or window-target failures.
- **Tool management**: enable / disable tools from the panel and persist tool selections in project-local configuration.
- **AI client config generation**: write MCP configuration for `codex` and `opencode` directly from the extension panel.
- **Runtime hot reload behavior**: clears internal module cache on reload so the extension can pick up newly built code instead of reusing stale modules.

## Repository Layout

```text
cocos-mcp-server/
├── source/                   # main extension source
│   ├── main.ts              # extension entry
│   ├── mcp-server.ts        # HTTP MCP server
│   ├── runtime-modules.ts   # runtime module hot reload
│   ├── client-config.ts     # Codex / OpenCode config writer
│   ├── settings.ts          # plugin and tool config persistence
│   ├── panels/              # panel logic
│   ├── tools/               # tool implementations
│   └── test/                # local validation scripts
├── stdio-adapter/           # stdio → HTTP MCP proxy
│   ├── src/
│   └── build/
├── static/                  # panel templates and styles
├── dist/                    # compiled extension output
└── package.json
```

## Installation

### 1. Place it under `extensions/`

Copy the entire folder into your Cocos Creator project:

```text
YourProject/
├── assets/
├── extensions/
│   └── cocos-mcp-server/
└── settings/
```

### 2. Install main extension dependencies

```bash
cd extensions/cocos-mcp-server
npm install
```

### 3. Build the main extension

```bash
npm run build
```

The main extension outputs compiled files into `dist/`.

### 4. Build the stdio adapter

If you want to connect `stdio`-based MCP clients, build the adapter as well:

```bash
cd stdio-adapter
npm install
npm run build
```

The adapter outputs to `stdio-adapter/build/index.js`.

## Enabling It in Cocos Creator

1. Open or refresh your project.
2. Go to `Extension > Cocos MCP Server`.
3. Open the panel, configure service settings, and start the server.

Current defaults from source:

- default port: `9527`
- `autoStart`: `false`
- `enableDebugLog`: `false`
- `maxConnections`: `10`

Project-local configuration is written to:

- `settings/mcp-server.json`
- `settings/tool-manager.json`

## Panel Features

The default panel currently handles four major tasks.

### 1. Service control

- start / stop the local MCP service
- inspect runtime status
- inspect the current HTTP address
- update port, auto-start, debug logging, and max connections

### 2. Tool toggles

- load the current tool list
- enable / disable individual tools
- enable / disable tools by category
- batch-save tool state

### 3. Tool configuration management

- auto-create a default configuration
- create new configurations
- switch the active configuration
- import / export configurations

### 4. AI client configuration

The panel can write MCP configuration for:

- `codex`
- `opencode`
- both clients at once

and can write either:

- project-local config
- global user config

Notes:

- The built-in auto-write flow currently only covers `codex` and `opencode`.
- **Claude Code must currently be configured manually**, preferably through a project-level `.mcp.json` file or `claude mcp add`.

## MCP Connection Modes

The repository supports two connection styles.

### Mode 1: HTTP MCP

Once the extension is started, it exposes a local HTTP service.

Default endpoint:

```text
http://127.0.0.1:9527/mcp
```

It also exposes helper endpoints:

- `GET /health`
- `GET /status`
- `GET /capabilities`
- `POST /call-tool`
- `GET /api/tools`
- `POST /api/{category}/{tool}`

If your client supports HTTP MCP directly, this is the simplest integration path.

### Mode 2: stdio adapter

For clients that prefer `stdio`, the repository includes a minimal proxy that:

- reads line-based JSON-RPC from `stdin`
- forwards it to `http://127.0.0.1:<port>/mcp`
- writes the response back to `stdout`

It reads the port from:

```text
COCOS_MCP_PORT
```

and falls back to `9527`.

## Client Configuration Examples

### Claude Code (recommended: project-level `.mcp.json`)

Claude Code officially supports loading MCP servers from a `.mcp.json` file at the project root. For this plugin, the recommended integration is direct HTTP transport:

```json
{
  "mcpServers": {
    "cocos-mcp": {
      "type": "http",
      "url": "http://127.0.0.1:9527/mcp"
    }
  }
}
```

If you want the port to track an environment variable, you can also use:

```json
{
  "mcpServers": {
    "cocos-mcp": {
      "type": "http",
      "url": "http://127.0.0.1:${COCOS_MCP_PORT:-9527}/mcp"
    }
  }
}
```

This is a good fit when:

- you want the Claude Code MCP setup to be shared with the project
- you want the config to live in version control
- you do not want to depend on per-user global configuration

### Claude Code (CLI add)

If you prefer the built-in Claude Code CLI workflow, you can add the server directly as a project-scoped HTTP MCP server:

```bash
claude mcp add --transport http --scope project cocos-mcp http://127.0.0.1:9527/mcp
```

Useful follow-up commands:

```bash
claude mcp list
claude mcp get cocos-mcp
claude mcp remove cocos-mcp
```

Inside a Claude Code session, use:

```text
/mcp
```

to inspect connection status, server health, and advertised tool counts.

### Codex

Project-local `.codex/config.toml` is written in this shape:

```toml
[mcp_servers.cocos-mcp]
type = "stdio"
command = "node"
args = ["extensions/cocos-mcp-server/stdio-adapter/build/index.js"]
```

### OpenCode

Project-local `opencode.json` is written in this shape:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "cocos-mcp": {
      "type": "local",
      "command": ["node", "extensions/cocos-mcp-server/stdio-adapter/build/index.js"],
      "enabled": true,
      "timeout": 30000
    }
  }
}
```

### Claude / generic HTTP clients

If the client supports HTTP MCP, point it at:

```text
http://127.0.0.1:9527/mcp
```

For Claude Code specifically, the official guidance currently favors HTTP transport over SSE when HTTP is available.

## Tool Domains and Grouping

The source currently uses both “tool categories” and “tool groups”.

### Main tool categories

Current implementation covers these categories:

- `scene`
- `node`
- `component`
- `prefab`
- `project`
- `assetAdvanced`
- `debug`
- `validation`
- `editor`
- `sceneView`
- `sceneAdvanced`
- `preferences`
- `server`
- `broadcast`
- `referenceImage`
- `batch`
- `material`
- `meta`

### Tool groups

Tool groups are meant to reduce AI context noise. They are not a permission model.

Available groups:

- `core`
- `component`
- `prefab`
- `asset`
- `debug`
- `editor`
- `preferences`
- `server`
- `reference`
- `batch`

Default active groups:

- `core`
- `component`
- `prefab`
- `asset`
- `debug`
- `editor`
- `batch`

`core` cannot be deactivated.

## Development

### Main extension

```bash
cd extensions/cocos-mcp-server
npm install
npm run build
npm run watch
```

### stdio adapter

```bash
cd extensions/cocos-mcp-server/stdio-adapter
npm install
npm run build
```

### Local validation scripts

The repository already includes local validation scripts under `source/test/`, such as:

- `manual-test.ts`
- `mcp-tool-tester.ts`
- `prefab-tools-test.ts`
- `editor-tools-save-scene-test.ts`
- `color-parser-test.ts`

These are best understood as repo-local verification helpers, not a complete test framework.

## Known Limitations

To keep this README aligned with the actual repository, these limitations should be explicit:

- This is a **project-local extension** and does not run independently outside the Cocos Creator editor environment.
- Some capabilities are editor-command or panel-driven workflows rather than low-level fully headless APIs.
- Build-related tools currently focus more on opening the build panel, querying readiness, and controlling preview helpers than fully replacing the manual build workflow.
- `stdio`-based clients depend on `stdio-adapter/build/index.js`; if the adapter has not been built, those clients will fail to connect.
- Supporting docs such as GitNexus index state, feature guides, and historical changelogs may lag behind source. When in doubt, trust `source/`.

## Troubleshooting

### The service does not start

Check these first:

1. the main extension has been built with `npm install && npm run build`
2. the extension is actually loaded by Cocos Creator
3. port `9527` is not already in use
4. `settings/mcp-server.json` does not contain broken values

### The client cannot connect

Check these first:

1. the service is running in the panel
2. `http://127.0.0.1:9527/health` responds
3. for `stdio` clients, `stdio-adapter/build/index.js` exists
4. if using a non-default port, `COCOS_MCP_PORT` is also updated

### Code changed but the editor still behaves like old code

The repository already implements runtime module cache clearing, but you still need to:

1. rebuild
2. refresh or re-enable the extension in the editor

If behavior is still stale, verify that `dist/` actually contains the latest build output.

## License

This plugin is distributed with source code and is intended for learning, communication, and secondary development / optimization in Cocos Creator projects.

Without explicit authorization, this project and derivative code should not be used for commercial distribution or resale. Contact the author for commercial use.

## Contact

## Contact me to join the group
<img alt="image" src="https://github.com/user-attachments/assets/a276682c-4586-480c-90e5-6db132e89e0f" width="400" height="400" />
