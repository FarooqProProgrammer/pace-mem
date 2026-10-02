# pace-mem

Persistent memory for Claude Code and Cursor. pace-mem records what each session does, compresses it into short searchable **observations** (decisions, bug fixes, discoveries, changes), writes a summary after each request, and gives new sessions an index of recent work, so Claude doesn't start from zero every time.

- **Automatic**: five Claude Code hooks capture prompts and tool calls. Nothing to remember to run.
- **Cheap to recall**: new sessions get a compact index; details are fetched on demand through 3 MCP tools (`search` → `timeline` → `get_observations`).
- **Local**: one SQLite file (`~/.pace-mem/pace-mem.db`) with FTS5 search. Only Node is required (≥ 22.13, built-in `node:sqlite`); no Bun, Python or native modules.
- **Private by default**: `<private>…</private>` content is never stored, and common secrets (API keys, tokens, private keys, connection strings) are replaced with `<redacted/>` before anything is written or sent to a model.

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

Cursor and Claude Code share one database, so memories recorded in one editor show up in the other for the same project folder. If Claude Code isn't installed, switch the provider to **Anthropic API key** in the dashboard (the default provider runs the `claude` CLI).

## Dashboard

http://127.0.0.1:37800 (or your configured port):

- **Memories**: live feed, search, filter by project and type, delete individual memories.
- **Settings**: provider, model, effort, API key (stored in `settings.json`, never sent back to the browser), session-context size with a live preview of what new sessions see, secret redaction, ignored tools, payload size, batching, port. Saved changes apply to the running worker immediately (the port needs a restart). **Test connection** makes one small model call with the saved settings.
- **Integrations**: Claude Code plugin status; install, update or remove Cursor.
- **Status**: counts, queue and failed events (with retry), per-project stats, delete a project's memory (type the name to confirm), file locations.

The dashboard talks to the worker on localhost only; the worker rejects non-local Host headers and non-JSON writes.

> If you also run claude-mem, disable one of them. Running both doubles the compression cost and injects two context blocks.

## How it works

```
Claude Code ──hooks──▶ hook.mjs ──HTTP (2s, fire-and-forget)──▶ worker (127.0.0.1:37800)
                                                                  │
   SessionStart      → GET  /api/context      ◀── index injected  │  SQLite + FTS5
   UserPromptSubmit  → POST /api/sessions/prompt                  │  tool_events (queue + raw log)
   PostToolUse       → POST /api/events       ── queued ──▶ processor ──▶ model ──▶ observations
   Stop              → POST /api/sessions/summarize               │                  summaries
   SessionEnd        → POST /api/sessions/end                     │
                                                                  │
Claude ──MCP (stdio)──▶ mcp.mjs ──HTTP──▶ /api/search, /api/timeline, /api/observations/batch
Browser ──────────────────────────────▶ /  (viewer, live via SSE)
```

1. **Capture.** Every tool call is sanitized (private tags, secrets, size cap) and appended to a durable queue. Housekeeping tools (TodoWrite, AskUserQuestion, …) and pace-mem's own MCP calls are skipped.
2. **Compress.** The worker waits a few seconds for a burst of tool calls to settle, then sends up to 15 of them, all from the same user request, to the model in **one** call. The model merges related events and drops trivial ones, returning structured observations. Failed calls back off and retry up to 3 times; a crashed worker requeues in-flight work on restart.
3. **Summarize.** When Claude finishes a response (Stop hook), the worker waits for that request's queue to drain, then writes a summary: request, what was investigated, learned, completed, next steps.
4. **Recall.** SessionStart injects the latest summaries plus an index of recent observations for the project (the folder name of the working directory). Claude pulls full details through the MCP tools only when needed.

## Configuration

Use the dashboard's Settings tab, or edit `~/.pace-mem/settings.json` (all keys optional):

| Key | Default | Meaning |
|---|---|---|
| `provider` | `"claude-cli"` | `claude-cli` runs `claude -p` with your existing Claude Code login. `anthropic` calls the API with `anthropicApiKey` or `ANTHROPIC_API_KEY`. |
| `anthropicApiKey` | none | API key for the `anthropic` provider. Useful when the editor doesn't pass `ANTHROPIC_API_KEY` to the worker. |
| `model` | `"claude-opus-5-5"` | Model used for compression and summaries. `"claude-haiku-4-5"` is much cheaper. |
| `effort` | `"low"` | Effort level for compression calls. Ignored for models that don't support it (e.g. Haiku 4.5). |
| `port` | `37800` | Worker port (localhost only). |
| `batchSize` | `15` | Max tool events per model call. |
| `batchDelaySeconds` | `4` | Quiet period before a batch is compressed. |
| `contextObservations` | `40` | Observations listed at session start. |
| `contextSummaries` | `3` | Summaries included at session start. |
| `redactSecrets` | `true` | Regex-based secret redaction before storage. |
| `skipTools` | see `src/shared/config.ts` | Tool names never recorded. |
| `maxPayloadBytes` | `16000` | Per-field cap on stored tool input/output. |

Environment overrides: `PACE_MEM_PORT`, `PACE_MEM_PROVIDER`, `PACE_MEM_MODEL`, `PACE_MEM_DATA_DIR`. Restart the worker after changing settings (`pace-mem stop`; the next session starts it again).

**Cost:** each compression call sends one batch of tool events (not one call per tool use). Summaries add one call per request that produced observations. With `claude-cli`, usage counts against your Claude plan; with `anthropic`, against your API key.

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
