#!/usr/bin/env node
import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);

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
function projectFromCwd(cwd) {
  if (!cwd) return "default";
  return basename(cwd.replace(/[\\/]+$/, "")) || "default";
}
var DISABLE_ENV = "PACE_MEM_DISABLED";

// src/shared/privacy.ts
var SECRET_KEY = String.raw`[A-Za-z0-9_]*(?:password|passwd|secret|api[_-]?key|access[_-]?token|auth[_-]?token|private[_-]?key)[A-Za-z0-9_]*`;
var QUOTED_ASSIGNMENT = new RegExp(String.raw`\b(${SECRET_KEY})(["']?\s*[:=]\s*)(["'])([^"'\s]{6,})\3`, "gi");
var BARE_ASSIGNMENT = new RegExp(String.raw`\b(${SECRET_KEY})(\s*[:=]\s*)([A-Za-z0-9_\-+/=!@#$%^&*~]{8,})(?=[\s;,]|$)`, "gim");
function truncate(text, maxBytes) {
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes <= maxBytes) return text;
  const cut = Buffer.from(text, "utf8").subarray(0, maxBytes).toString("utf8");
  return `${cut}
\u2026[truncated: ${bytes - maxBytes} bytes]`;
}
function toText(value) {
  if (value == null) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
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

// src/hooks/hosts.ts
var str = (v) => typeof v === "string" && v ? v : void 0;
var claudeCode = {
  event: (name) => ["session-start", "prompt", "post-tool", "stop", "session-end"].find((e) => e === name),
  normalize: (raw) => ({
    session_id: str(raw.session_id),
    cwd: str(raw.cwd),
    prompt: str(raw.prompt),
    tool_name: str(raw.tool_name),
    tool_input: raw.tool_input,
    tool_response: raw.tool_response,
    tool_use_id: str(raw.tool_use_id)
  }),
  reply: (event, context) => event === "session-start" && context ? JSON.stringify({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: context } }) : "",
  isOwnTool: (name) => name.includes("pace-mem")
};
var CURSOR_EVENTS = {
  sessionStart: "session-start",
  beforeSubmitPrompt: "prompt",
  postToolUse: "post-tool",
  stop: "stop",
  sessionEnd: "session-end"
};
var OWN_MCP_TOOLS = /* @__PURE__ */ new Set(["MCP:search", "MCP:timeline", "MCP:get_observations"]);
var cursor = {
  event: (name) => CURSOR_EVENTS[name],
  normalize: (raw) => {
    const roots = Array.isArray(raw.workspace_roots) ? raw.workspace_roots.filter((r) => typeof r === "string") : [];
    return {
      // conversation_id is on every agent hook; session_id only on session hooks.
      session_id: str(raw.conversation_id) ?? str(raw.session_id),
      // The workspace root, not the tool's cwd, so a `cd` into a subfolder stays in the same project.
      cwd: roots[0] ?? str(process.env.CURSOR_PROJECT_DIR) ?? str(raw.cwd),
      prompt: str(raw.prompt),
      tool_name: str(raw.tool_name),
      tool_input: raw.tool_input,
      tool_response: raw.tool_output,
      tool_use_id: str(raw.tool_use_id)
    };
  },
  // Cursor parses stdout as JSON for every hook, so always print an object.
  reply: (event, context) => {
    if (event === "session-start") return JSON.stringify(context ? { additional_context: context } : {});
    if (event === "prompt") return JSON.stringify({ continue: true });
    return "{}";
  },
  isOwnTool: (name) => OWN_MCP_TOOLS.has(name) || name.includes("pace-mem")
};
var HOSTS = { claude: claudeCode, cursor };

// src/hooks/hook.ts
var MAX_FIELD = 256e3;
async function readStdin() {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  const text = Buffer.concat(chunks).toString("utf8");
  return text.trim() ? JSON.parse(text) : {};
}
async function send(path, body) {
  if (!await isHealthy(300)) {
    if (!await ensureWorker(3e3)) return;
  }
  await request(path, { body, timeoutMs: 2e3 }).catch(() => void 0);
}
async function run(event, i, host) {
  switch (event) {
    case "session-start": {
      if (!await ensureWorker()) return;
      const project = projectFromCwd(i.cwd);
      const res = await request(`/api/context?project=${encodeURIComponent(project)}`, { timeoutMs: 5e3 });
      return res.ok ? await res.text() || void 0 : void 0;
    }
    case "prompt":
      if (!i.session_id) return;
      return void await send("/api/sessions/prompt", { session_id: i.session_id, cwd: i.cwd, prompt: i.prompt });
    case "post-tool":
      if (!i.session_id || !i.tool_name || host.isOwnTool(i.tool_name)) return;
      return void await send("/api/events", {
        session_id: i.session_id,
        cwd: i.cwd,
        tool_name: i.tool_name,
        tool_use_id: i.tool_use_id,
        tool_input: truncate(toText(i.tool_input), MAX_FIELD),
        tool_response: truncate(toText(i.tool_response), MAX_FIELD)
      });
    case "stop":
      if (!i.session_id) return;
      return void await send("/api/sessions/summarize", { session_id: i.session_id, cwd: i.cwd });
    case "session-end":
      if (!i.session_id) return;
      return void await send("/api/sessions/end", { session_id: i.session_id, cwd: i.cwd });
  }
}
async function main() {
  const args = process.argv.slice(2);
  const host = HOSTS[args[0]] && args.length > 1 ? HOSTS[args.shift()] : claudeCode;
  const event = host.event(args[0] ?? "");
  if (!event) return "";
  let context;
  try {
    if (process.env[DISABLE_ENV] !== "1") context = await run(event, host.normalize(await readStdin()), host);
  } catch (err) {
    if (process.env.PACE_MEM_DEBUG) process.stderr.write(`pace-mem hook: ${err?.stack ?? err}
`);
  }
  return host.reply(event, context);
}
main().catch(() => "").then((out) => out ? process.stdout.write(out, () => process.exit(0)) : process.exit(0));
