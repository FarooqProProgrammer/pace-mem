# pace-mem

Persistent memory for Claude Code and Cursor. pace-mem gives new sessions an index of recent work, and the coding agent stores durable **observations** (decisions, bug fixes, discoveries, changes) itself through MCP tools (`save_memory`, `save_summary`). There is no separate compression model to configure.

- **Agent-written**: the session agent calls `save_memory` when it learns something worth keeping. Hooks only track the session and inject context.
- **Cheap to recall**: new sessions get a compact index; details are fetched on demand through MCP (`search` → `timeline` → `get_observations`).
- **Local**: one SQLite file (`~/.pace-mem/pace-mem.db`) with FTS5 search. Only Node is required (≥ 22.13, built-in `node:sqlite`); no Bun, Python or native modules.
- **Private by default**: `<private>…</private>` content is never stored, and common secrets (API keys, tokens, private keys, connection strings) are replaced with `<redacted/>` before anything is written.

## Install

```bash
# from a clone of this repo (or use the GitHub URL once it's pushed)
claude plugin marketplace add D:/product/mem
claude plugin install pace-mem@pace-mem
```

Restart Claude Code. The worker starts automatically on the first session; open the dashboard at **http://127.0.0.1:37800**.

### Cursor

```bash
npm install && npm run build            # only when working from source
node plugin/scripts/cli.mjs cursor install            # all projects (~/.cursor)
node plugin/scripts/cli.mjs cursor install --project path/to/repo   # one project
```

Or use **Integrations → Install in Cursor** in the dashboard. The installer copies the scripts to `~/.pace-mem/runtime`, merges five hooks (`sessionStart`, `beforeSubmitPrompt`, `postToolUse`, `stop`, `sessionEnd`) into Cursor's `hooks.json` and the MCP server into `mcp.json`, keeps other tools' entries, and saves the previous files as `*.pace-mem.bak`. Reload Cursor afterwards. `cursor uninstall` removes only pace-mem's entries.

Cursor and Claude Code share one database, so memories recorded in one editor show up in the other for the same project folder.

## Dashboard

http://127.0.0.1:37800 (or your configured port):

- **Memories**: live feed, search, filter by project and type, delete individual memories.
- **Settings**: session-context size with a live preview of what new sessions see, secret redaction, ignored tools, payload size, port. Saved changes apply to the running worker immediately (the port needs a restart).
- **Integrations**: Claude Code plugin status; install, update or remove Cursor.
- **Status**: counts, per-project stats, delete a project's memory (type the name to confirm), file locations.

The dashboard talks to the worker on localhost only; the worker rejects non-local Host headers and non-JSON writes.

> If you also run claude-mem, disable one of them. Running both injects two context blocks.

## How it works

```
Claude Code ──hooks──▶ hook.mjs ──HTTP (2s, fire-and-forget)──▶ worker (127.0.0.1:37800)
                                                                  │
   SessionStart      → GET  /api/context      ◀── index injected  │  SQLite + FTS5
   UserPromptSubmit  → POST /api/sessions/prompt                  │
   SessionEnd        → POST /api/sessions/end                     │
                                                                  │
Claude ──MCP (stdio)──▶ mcp.mjs ──HTTP──▶ /api/search, /api/timeline, /api/observations/batch
                                 POST ──▶ /api/memory/save, /api/memory/summary
Browser ──────────────────────────────▶ /  (viewer, live via SSE)
```

1. **Recall.** SessionStart injects the latest summaries plus an index of recent observations for the project (the folder name of the working directory). The agent pulls full details through `search` → `timeline` → `get_observations` only when needed.
2. **Write.** The agent persists durable knowledge with `save_memory` and, after a substantial request, `save_summary`. There is no background model that compresses tool calls into memories.

## Configuration

Use the dashboard's Settings tab, or edit `~/.pace-mem/settings.json` (all keys optional):

| Key | Default | Meaning |
|---|---|---|
| `port` | `37800` | Worker port (localhost only). |
| `contextObservations` | `40` | Observations listed at session start. |
| `contextSummaries` | `3` | Summaries included at session start. |
| `redactSecrets` | `true` | Regex-based secret redaction before storage. |
| `skipTools` | see `src/shared/config.ts` | Tool names never recorded by hooks. |
| `maxPayloadBytes` | `16000` | Per-field cap on stored memory text. |

Environment overrides: `PACE_MEM_PORT`, `PACE_MEM_DATA_DIR`. Restart the worker after changing settings (`pace-mem stop`; the next session starts it again).

## CLI

```bash
node plugin/scripts/cli.mjs status          # or `pace-mem status` after `npm link`
node plugin/scripts/cli.mjs search jwt expiry --project shop-api
node plugin/scripts/cli.mjs show 12 15
node plugin/scripts/cli.mjs context          # what a new session here would see
node plugin/scripts/cli.mjs logs 100
node plugin/scripts/cli.mjs retry            # requeue events that failed to compress
node plugin/scripts/cli.mjs stop
```

## Privacy

- Wrap anything in `<private>…</private>` in a prompt and it is removed before storage. A prompt that is entirely private is not stored at all.
- Secret redaction covers Anthropic/OpenAI/GitHub/Slack/AWS/Google keys, JWTs, PEM private keys, credentials in connection strings, and `password=` / `api_key:`-style literals. It is pattern-based, so treat it as a safety net rather than a guarantee.
- The worker binds to `127.0.0.1`, rejects requests whose `Host` isn't local (DNS rebinding), and accepts only `application/json` POSTs (no cross-site form posts).

## Development

```bash
npm install
npm run typecheck
npm test            # store, privacy, and full worker lifecycle with a fake model
npm run build       # bundles src/ into plugin/scripts/*.mjs (committed, so installs need no npm)
```

| Path | What |
|---|---|
| `src/hooks/hook.ts`, `hosts.ts` | Hook entry point and per-editor adapters (`hook.mjs <event>`, `hook.mjs cursor <hookName>`) |
| `src/cli/cursor.ts` | Cursor installer (merges `hooks.json` / `mcp.json`) |
| `src/worker/viewer.ts`, `settings.ts` | Dashboard page and settings validation |
| `src/worker/` | HTTP server, queue processor, model providers, prompts |
| `src/db/store.ts` | SQLite schema, queue operations, FTS5 search |
| `src/mcp/server.ts` | MCP tools over stdio |
| `src/cli/index.ts` | `pace-mem` CLI |
| `plugin/` | What Claude Code installs: manifest, hooks, MCP config, skill, bundled scripts |

Run a worker against a scratch database: `PACE_MEM_DATA_DIR=/tmp/pm PACE_MEM_PORT=37899 PACE_MEM_LOG_STDOUT=1 node plugin/scripts/worker.mjs`.

## Credits

pace-mem is an independent implementation inspired by the design of [claude-mem](https://github.com/thedotmack/claude-mem) (Apache-2.0): its hook lifecycle, observation model, and progressive-disclosure search. No claude-mem code is included.
