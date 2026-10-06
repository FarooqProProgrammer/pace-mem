#!/usr/bin/env node
import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);

// src/cli/index.ts
import { existsSync as existsSync3, readFileSync as readFileSync3 } from "node:fs";
import { join as join3, resolve } from "node:path";
import { fileURLToPath as fileURLToPath2 } from "node:url";

// src/shared/config.ts
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
var DEFAULT_SKIP_TOOLS = [
  "TodoWrite",
  "TodoRead",
  "TaskCreate",
  "TaskUpdate",
  "TaskList",
  "TaskGet",
  "TaskOutput",
  "AskUserQuestion",
  "ExitPlanMode",
  "EnterPlanMode",
  "ToolSearch",
  "ListMcpResourcesTool",
  "ScheduleWakeup"
];
var DEFAULTS = {
  port: 37800,
  provider: "claude-cli",
  model: "claude-opus-5-5",
  effort: "low",
  batchSize: 15,
  batchDelaySeconds: 4,
  contextObservations: 40,
  contextSummaries: 3,
  redactSecrets: true,
  skipTools: DEFAULT_SKIP_TOOLS,
  maxPayloadBytes: 16e3
};
function dataDir() {
  const dir = process.env.PACE_MEM_DATA_DIR || join(homedir(), ".pace-mem");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}
var paths = {
  db: () => join(dataDir(), "pace-mem.db"),
  settings: () => join(dataDir(), "settings.json"),
  pid: () => join(dataDir(), "worker.pid"),
  log: () => join(dataDir(), "worker.log")
};
var cached;
function loadSettings() {
  if (cached) return cached;
  let file = {};
  try {
    if (existsSync(paths.settings())) file = JSON.parse(readFileSync(paths.settings(), "utf8"));
  } catch {
  }
  const env = process.env;
  cached = {
    ...DEFAULTS,
    ...file,
    ...env.PACE_MEM_PORT ? { port: Number(env.PACE_MEM_PORT) } : {},
    ...env.PACE_MEM_PROVIDER ? { provider: env.PACE_MEM_PROVIDER } : {},
    ...env.PACE_MEM_MODEL ? { model: env.PACE_MEM_MODEL } : {}
  };
  return cached;
}
function workerUrl(path = "") {
  return `http://127.0.0.1:${loadSettings().port}${path}`;
}

// src/shared/worker-client.ts
import { spawn } from "node:child_process";
import { openSync } from "node:fs";
import { fileURLToPath } from "node:url";
async function request(path, init = {}) {
  return fetch(workerUrl(path), {
    method: init.method ?? (init.body === void 0 ? "GET" : "POST"),
    headers: init.body === void 0 ? void 0 : { "content-type": "application/json" },
    body: init.body === void 0 ? void 0 : JSON.stringify(init.body),
    signal: AbortSignal.timeout(init.timeoutMs ?? 5e3)
  });
}
async function isHealthy(timeoutMs = 1e3) {
  try {
    return (await request("/api/health", { timeoutMs })).ok;
  } catch {
    return false;
  }
}
function workerScript() {
  return fileURLToPath(new URL("./worker.mjs", import.meta.url));
}
function spawnWorker() {
  const out = openSync(paths.log(), "a");
  const child = spawn(process.execPath, [workerScript()], {
    detached: true,
    stdio: ["ignore", out, out],
    windowsHide: true
  });
  child.unref();
}
async function ensureWorker(waitMs = 8e3) {
  if (await isHealthy()) return true;
  spawnWorker();
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 200));
    if (await isHealthy(500)) return true;
  }
  return false;
}

// src/cli/cursor.ts
import { copyFileSync, existsSync as existsSync2, mkdirSync as mkdirSync2, readFileSync as readFileSync2, writeFileSync } from "node:fs";
import { homedir as homedir2 } from "node:os";
import { join as join2 } from "node:path";
var CURSOR_HOOKS = [
  { event: "sessionStart", timeout: 30 },
  { event: "beforeSubmitPrompt", timeout: 10 },
  { event: "postToolUse", timeout: 10 },
  { event: "stop", timeout: 10 },
  { event: "sessionEnd", timeout: 10 }
];
var RUNTIME_FILES = ["hook.mjs", "worker.mjs", "mcp.mjs", "cli.mjs"];
var MCP_NAME = "pace-mem";
var OUR_COMMAND = new RegExp(`hook\\.mjs"? cursor (${CURSOR_HOOKS.map((h) => h.event).join("|")})$`);
var isOurHook = (h) => typeof h?.command === "string" && OUR_COMMAND.test(h.command.trim());
function hookCommand(t, event) {
  const hook = join2(t.runtimeDir, "hook.mjs");
  const call = `"${t.nodePath}" "${hook}" cursor ${event}`;
  return t.platform === "win32" ? `& ${call}` : call;
}
function mergeHooks(existing, t) {
  const hooks = {};
  for (const [event, entries] of Object.entries(existing.hooks ?? {})) {
    const kept = (entries ?? []).filter((h) => !isOurHook(h));
    if (kept.length) hooks[event] = kept;
  }
  for (const { event, timeout } of CURSOR_HOOKS) {
    hooks[event] = [...hooks[event] ?? [], { command: hookCommand(t, event), timeout }];
  }
  return { ...existing, version: existing.version ?? 1, hooks };
}
function removeHooks(existing) {
  const hooks = {};
  for (const [event, entries] of Object.entries(existing.hooks ?? {})) {
    const kept = (entries ?? []).filter((h) => !isOurHook(h));
    if (kept.length) hooks[event] = kept;
  }
  return { ...existing, hooks };
}
function mergeMcp(existing, t) {
  return {
    ...existing,
    mcpServers: { ...existing.mcpServers ?? {}, [MCP_NAME]: { command: t.nodePath, args: [join2(t.runtimeDir, "mcp.mjs")] } }
  };
}
function removeMcp(existing) {
  const { [MCP_NAME]: _removed, ...rest } = existing.mcpServers ?? {};
  return { ...existing, mcpServers: rest };
}
function otherMemoryTools(hooks, mcp) {
  const found = /* @__PURE__ */ new Set();
  const commands = Object.values(hooks.hooks ?? {}).flat().map((h) => h?.command ?? "");
  if (commands.some((c) => /claude-mem|thedotmack/i.test(c))) found.add("claude-mem");
  for (const name of Object.keys(mcp.mcpServers ?? {})) if (/mem/i.test(name) && name !== MCP_NAME) found.add(name);
  return [...found];
}
function readJson(path) {
  if (!existsSync2(path)) return {};
  const text2 = readFileSync2(path, "utf8");
  if (!text2.trim()) return {};
  try {
    return JSON.parse(text2);
  } catch {
    throw new Error(`${path} is not valid JSON; fix or move it, then run the installer again (nothing was changed)`);
  }
}
function writeJson(path, value) {
  if (existsSync2(path)) copyFileSync(path, `${path}.pace-mem.bak`);
  writeFileSync(path, `${JSON.stringify(value, null, 2)}
`);
}
function installCursor(t) {
  const hooksPath = join2(t.cursorDir, "hooks.json");
  const mcpPath = join2(t.cursorDir, "mcp.json");
  const hooks = readJson(hooksPath);
  const mcp = readJson(mcpPath);
  mkdirSync2(t.runtimeDir, { recursive: true });
  for (const f of RUNTIME_FILES) {
    const src = join2(t.sourceDir, f);
    if (!existsSync2(src)) throw new Error(`missing ${src}; run \`npm run build\` first`);
    copyFileSync(src, join2(t.runtimeDir, f));
  }
  mkdirSync2(t.cursorDir, { recursive: true });
  writeJson(hooksPath, mergeHooks(hooks, t));
  writeJson(mcpPath, mergeMcp(mcp, t));
  return { hooksPath, mcpPath, others: otherMemoryTools(hooks, mcp) };
}
function uninstallCursor(cursorDir) {
  const hooksPath = join2(cursorDir, "hooks.json");
  const mcpPath = join2(cursorDir, "mcp.json");
  const hooks = readJson(hooksPath);
  const mcp = readJson(mcpPath);
  if (existsSync2(hooksPath)) writeJson(hooksPath, removeHooks(hooks));
  if (existsSync2(mcpPath)) writeJson(mcpPath, removeMcp(mcp));
  return { hooksPath, mcpPath };
}
function cursorStatus(cursorDir) {
  const hooks = readJson(join2(cursorDir, "hooks.json"));
  const mcp = readJson(join2(cursorDir, "mcp.json"));
  return {
    hooks: Object.entries(hooks.hooks ?? {}).filter(([, entries]) => (entries ?? []).some(isOurHook)).map(([event]) => event),
    mcp: !!mcp.mcpServers?.[MCP_NAME]
  };
}
function userCursorDir() {
  return process.env.PACE_MEM_CURSOR_DIR || join2(homedir2(), ".cursor");
}

// src/cli/index.ts
var HELP = `pace-mem \u2014 persistent memory for Claude Code and Cursor

Usage:
  pace-mem start                 Start the background worker
  pace-mem stop                  Stop the worker
  pace-mem status                Worker health and memory counts
  pace-mem search <query> [--project <name>] [--type <type>] [--limit <n>]
  pace-mem show <id...>          Full details for observation IDs
  pace-mem context [project]     Print the context injected at session start
  pace-mem logs [lines]          Tail the worker log
  pace-mem viewer                Print the web viewer URL

  pace-mem cursor install [--project <dir>]    Add hooks + MCP server to Cursor (all projects, or one)
  pace-mem cursor uninstall [--project <dir>]  Remove them again
  pace-mem cursor status [--project <dir>]

Data:     ${paths.db()}
Settings: ${paths.settings()}`;
function flag(args, name) {
  const i = args.indexOf(`--${name}`);
  if (i === -1) return void 0;
  const [, value] = args.splice(i, 2);
  return value;
}
async function text(path, body) {
  if (!await ensureWorker()) throw new Error(`worker did not start; see ${paths.log()}`);
  const res = await request(path, { body, timeoutMs: 15e3 });
  const out = await res.text();
  if (!res.ok) throw new Error(out);
  return out;
}
function cursorCommand(args) {
  const project = flag(args, "project");
  const cursorDir = project ? join3(resolve(project), ".cursor") : userCursorDir();
  const scope = project ? `project ${resolve(project)}` : "all Cursor projects";
  switch (args[0]) {
    case "install": {
      const runtimeDir = join3(dataDir(), "runtime");
      const result = installCursor({
        cursorDir,
        runtimeDir,
        sourceDir: fileURLToPath2(new URL(".", import.meta.url)),
        nodePath: process.execPath,
        platform: process.platform
      });
      console.log(`Installed pace-mem for ${scope}:`);
      console.log(`  hooks:   ${result.hooksPath}`);
      console.log(`  mcp:     ${result.mcpPath}`);
      console.log(`  scripts: ${runtimeDir} (re-run this command after updating pace-mem)`);
      if (result.others.length) {
        console.log(
          `
! Also installed in Cursor: ${result.others.join(", ")}. Running two memory tools doubles model cost and context; consider removing one.`
        );
      }
      console.log("\nRestart Cursor (or reload the window) so it picks up the hooks and MCP tools.");
      return;
    }
    case "uninstall": {
      const r = uninstallCursor(cursorDir);
      return console.log(`Removed pace-mem from ${r.hooksPath} and ${r.mcpPath}. Your memory database is untouched.`);
    }
    case "status": {
      const st = cursorStatus(cursorDir);
      return console.log(
        `Cursor (${scope}): hooks ${st.hooks.length ? st.hooks.join(", ") : "not installed"} \xB7 MCP ${st.mcp ? "installed" : "not installed"}`
      );
    }
    default:
      console.log("Usage: pace-mem cursor <install|uninstall|status> [--project <dir>]");
  }
}
async function main() {
  const [cmd, ...args] = process.argv.slice(2);
  switch (cmd) {
    case "start": {
      const ok = await ensureWorker();
      console.log(ok ? `worker running at ${workerUrl()}` : `worker failed to start; see ${paths.log()}`);
      process.exitCode = ok ? 0 : 1;
      return;
    }
    case "stop": {
      if (!await isHealthy()) return console.log("worker is not running");
      await request("/api/shutdown", { body: {} });
      return console.log("worker stopped");
    }
    case "status": {
      const s = loadSettings();
      if (!await isHealthy()) return console.log(`worker: not running (port ${s.port})`);
      const [health, stats] = await Promise.all([
        request("/api/health").then((r) => r.json()),
        request("/api/stats").then((r) => r.json())
      ]);
      console.log(`worker: running \xB7 pid ${health.pid} \xB7 v${health.version} \xB7 ${workerUrl()}`);
      console.log(Object.entries(stats).map(([k, v]) => `${k}: ${v}`).join(" \xB7 "));
      return;
    }
    case "search": {
      const project = flag(args, "project");
      const type = flag(args, "type");
      const limit = flag(args, "limit");
      const q = new URLSearchParams({ query: args.join(" ") });
      if (project) q.set("project", project);
      if (type) q.set("type", type);
      if (limit) q.set("limit", limit);
      return console.log(await text(`/api/search?${q}`));
    }
    case "show":
      return console.log(await text("/api/observations/batch", { ids: args.map(Number) }));
    case "context": {
      const project = args[0] ?? process.cwd();
      const key = args[0] ? `project=${encodeURIComponent(project)}` : `cwd=${encodeURIComponent(project)}`;
      return console.log(await text(`/api/context?${key}`) || "(no memory for this project yet)");
    }
    case "logs": {
      if (!existsSync3(paths.log())) return console.log("no log yet");
      const lines = readFileSync3(paths.log(), "utf8").trimEnd().split("\n");
      return console.log(lines.slice(-Number(args[0] ?? 50)).join("\n"));
    }
    case "cursor":
      return cursorCommand(args);
    case "viewer":
      return console.log(workerUrl("/"));
    default:
      console.log(HELP);
  }
}
main().catch((err) => {
  console.error(`pace-mem: ${err.message ?? err}`);
  process.exitCode = 1;
});
