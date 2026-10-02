/**
 * Installs pace-mem into Cursor: hooks in hooks.json, the MCP server in mcp.json.
 * Existing entries from other tools are preserved; only pace-mem's own are replaced.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const CURSOR_HOOKS: { event: string; timeout: number }[] = [
  { event: 'sessionStart', timeout: 30 },
  { event: 'beforeSubmitPrompt', timeout: 10 },
  { event: 'postToolUse', timeout: 10 },
  { event: 'stop', timeout: 10 },
  { event: 'sessionEnd', timeout: 10 },
];

export const RUNTIME_FILES = ['hook.mjs', 'worker.mjs', 'mcp.mjs', 'cli.mjs'];
const MCP_NAME = 'pace-mem';

interface HookEntry {
  command: string;
  [k: string]: unknown;
}
interface HooksFile {
  version?: number;
  hooks?: Record<string, HookEntry[]>;
  [k: string]: unknown;
}
interface McpFile {
  mcpServers?: Record<string, unknown>;
  [k: string]: unknown;
}

export interface CursorTarget {
  /** `~/.cursor` for all projects, or `<project>/.cursor` for one. */
  cursorDir: string;
  /** Where the bundled scripts are copied so hooks don't depend on the repo location. */
  runtimeDir: string;
  /** Directory holding the freshly built scripts. */
  sourceDir: string;
  nodePath: string;
  platform: NodeJS.Platform;
}

// Matches the invocation, not the install path, which depends on PACE_MEM_DATA_DIR.
const OUR_COMMAND = new RegExp(`hook\\.mjs"? cursor (${CURSOR_HOOKS.map((h) => h.event).join('|')})$`);
export const isOurHook = (h: HookEntry) => typeof h?.command === 'string' && OUR_COMMAND.test(h.command.trim());

/** Cursor runs hook commands through PowerShell on Windows and sh elsewhere. */
export function hookCommand(t: Pick<CursorTarget, 'nodePath' | 'runtimeDir' | 'platform'>, event: string): string {
  const hook = join(t.runtimeDir, 'hook.mjs');
  const call = `"${t.nodePath}" "${hook}" cursor ${event}`;
  return t.platform === 'win32' ? `& ${call}` : call;
}

export function mergeHooks(existing: HooksFile, t: Pick<CursorTarget, 'nodePath' | 'runtimeDir' | 'platform'>): HooksFile {
  const hooks: Record<string, HookEntry[]> = {};
  for (const [event, entries] of Object.entries(existing.hooks ?? {})) {
    const kept = (entries ?? []).filter((h) => !isOurHook(h));
    if (kept.length) hooks[event] = kept;
  }
  for (const { event, timeout } of CURSOR_HOOKS) {
    hooks[event] = [...(hooks[event] ?? []), { command: hookCommand(t, event), timeout }];
  }
  return { ...existing, version: existing.version ?? 1, hooks };
}

export function removeHooks(existing: HooksFile): HooksFile {
  const hooks: Record<string, HookEntry[]> = {};
  for (const [event, entries] of Object.entries(existing.hooks ?? {})) {
    const kept = (entries ?? []).filter((h) => !isOurHook(h));
    if (kept.length) hooks[event] = kept;
  }
  return { ...existing, hooks };
}

export function mergeMcp(existing: McpFile, t: Pick<CursorTarget, 'nodePath' | 'runtimeDir'>): McpFile {
  return {
    ...existing,
    mcpServers: { ...(existing.mcpServers ?? {}), [MCP_NAME]: { command: t.nodePath, args: [join(t.runtimeDir, 'mcp.mjs')] } },
  };
}

export function removeMcp(existing: McpFile): McpFile {
  const { [MCP_NAME]: _removed, ...rest } = existing.mcpServers ?? {};
  return { ...existing, mcpServers: rest };
}

/** Names of other memory tools already wired into Cursor (running two doubles cost and context). */
export function otherMemoryTools(hooks: HooksFile, mcp: McpFile): string[] {
  const found = new Set<string>();
  const commands = Object.values(hooks.hooks ?? {}).flat().map((h) => h?.command ?? '');
  if (commands.some((c) => /claude-mem|thedotmack/i.test(c))) found.add('claude-mem');
  for (const name of Object.keys(mcp.mcpServers ?? {})) if (/mem/i.test(name) && name !== MCP_NAME) found.add(name);
  return [...found];
}

function readJson<T>(path: string): T {
  if (!existsSync(path)) return {} as T;
  const text = readFileSync(path, 'utf8');
  if (!text.trim()) return {} as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`${path} is not valid JSON; fix or move it, then run the installer again (nothing was changed)`);
  }
}

function writeJson(path: string, value: unknown): void {
  // Keep the previous version next to the file, in case anything needs to be restored.
  if (existsSync(path)) copyFileSync(path, `${path}.pace-mem.bak`);
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

export function installCursor(t: CursorTarget): { hooksPath: string; mcpPath: string; others: string[] } {
  const hooksPath = join(t.cursorDir, 'hooks.json');
  const mcpPath = join(t.cursorDir, 'mcp.json');
  // Parse both before writing anything, so a bad file leaves everything untouched.
  const hooks = readJson<HooksFile>(hooksPath);
  const mcp = readJson<McpFile>(mcpPath);

  mkdirSync(t.runtimeDir, { recursive: true });
  for (const f of RUNTIME_FILES) {
    const src = join(t.sourceDir, f);
    if (!existsSync(src)) throw new Error(`missing ${src}; run \`npm run build\` first`);
    copyFileSync(src, join(t.runtimeDir, f));
  }
  mkdirSync(t.cursorDir, { recursive: true });
  writeJson(hooksPath, mergeHooks(hooks, t));
  writeJson(mcpPath, mergeMcp(mcp, t));
  return { hooksPath, mcpPath, others: otherMemoryTools(hooks, mcp) };
}

export function uninstallCursor(cursorDir: string): { hooksPath: string; mcpPath: string } {
  const hooksPath = join(cursorDir, 'hooks.json');
  const mcpPath = join(cursorDir, 'mcp.json');
  const hooks = readJson<HooksFile>(hooksPath);
  const mcp = readJson<McpFile>(mcpPath);
  if (existsSync(hooksPath)) writeJson(hooksPath, removeHooks(hooks));
  if (existsSync(mcpPath)) writeJson(mcpPath, removeMcp(mcp));
  return { hooksPath, mcpPath };
}

export function cursorStatus(cursorDir: string): { hooks: string[]; mcp: boolean } {
  const hooks = readJson<HooksFile>(join(cursorDir, 'hooks.json'));
  const mcp = readJson<McpFile>(join(cursorDir, 'mcp.json'));
  return {
    hooks: Object.entries(hooks.hooks ?? {})
      .filter(([, entries]) => (entries ?? []).some(isOurHook))
      .map(([event]) => event),
    mcp: !!mcp.mcpServers?.[MCP_NAME],
  };
}

export function userCursorDir(): string {
  return process.env.PACE_MEM_CURSOR_DIR || join(homedir(), '.cursor');
}
