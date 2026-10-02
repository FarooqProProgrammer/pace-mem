/** `pace-mem <command>`: manage the worker, install into editors, and query memory from a terminal. */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dataDir, loadSettings, paths, workerUrl } from '../shared/config.js';
import { ensureWorker, isHealthy, request } from '../shared/worker-client.js';
import { cursorStatus, installCursor, uninstallCursor, userCursorDir } from './cursor.js';

const HELP = `pace-mem — persistent memory for Claude Code and Cursor

Usage:
  pace-mem start                 Start the background worker
  pace-mem stop                  Stop the worker
  pace-mem status                Worker health and memory counts
  pace-mem search <query> [--project <name>] [--type <type>] [--limit <n>]
  pace-mem show <id...>          Full details for observation IDs
  pace-mem context [project]     Print the context injected at session start
  pace-mem logs [lines]          Tail the worker log
  pace-mem retry                 Requeue tool events whose compression failed
  pace-mem viewer                Print the web viewer URL

  pace-mem cursor install [--project <dir>]    Add hooks + MCP server to Cursor (all projects, or one)
  pace-mem cursor uninstall [--project <dir>]  Remove them again
  pace-mem cursor status [--project <dir>]

Data:     ${paths.db()}
Settings: ${paths.settings()}`;

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  if (i === -1) return undefined;
  const [, value] = args.splice(i, 2);
  return value;
}

async function text(path: string, body?: unknown): Promise<string> {
  if (!(await ensureWorker())) throw new Error(`worker did not start; see ${paths.log()}`);
  const res = await request(path, { body, timeoutMs: 15_000 });
  const out = await res.text();
  if (!res.ok) throw new Error(out);
  return out;
}

function claudeCliAvailable(): boolean {
  return spawnSync('claude', ['--version'], { stdio: 'ignore', windowsHide: true }).status === 0;
}

function cursorCommand(args: string[]): void {
  const project = flag(args, 'project');
  const cursorDir = project ? join(resolve(project), '.cursor') : userCursorDir();
  const scope = project ? `project ${resolve(project)}` : 'all Cursor projects';
  switch (args[0]) {
    case 'install': {
      const runtimeDir = join(dataDir(), 'runtime');
      const result = installCursor({
        cursorDir,
        runtimeDir,
        sourceDir: fileURLToPath(new URL('.', import.meta.url)),
        nodePath: process.execPath,
        platform: process.platform,
      });
      console.log(`Installed pace-mem for ${scope}:`);
      console.log(`  hooks:   ${result.hooksPath}`);
      console.log(`  mcp:     ${result.mcpPath}`);
      console.log(`  scripts: ${runtimeDir} (re-run this command after updating pace-mem)`);
      if (result.others.length) {
        console.log(
          `\n! Also installed in Cursor: ${result.others.join(', ')}. ` +
            'Running two memory tools doubles model cost and context; consider removing one.',
        );
      }
      const s = loadSettings();
      if (s.provider === 'claude-cli' && !claudeCliAvailable()) {
        console.log(
          `\n! Compression uses the \`claude\` CLI, which isn't on PATH. Install Claude Code, or set in ${paths.settings()}:\n` +
            '    { "provider": "anthropic", "anthropicApiKey": "sk-ant-..." }',
        );
      }
      console.log('\nRestart Cursor (or reload the window) so it picks up the hooks.');
      return;
    }
    case 'uninstall': {
      const r = uninstallCursor(cursorDir);
      return console.log(`Removed pace-mem from ${r.hooksPath} and ${r.mcpPath}. Your memory database is untouched.`);
    }
    case 'status': {
      const st = cursorStatus(cursorDir);
      return console.log(
        `Cursor (${scope}): hooks ${st.hooks.length ? st.hooks.join(', ') : 'not installed'} · MCP ${st.mcp ? 'installed' : 'not installed'}`,
      );
    }
    default:
      console.log('Usage: pace-mem cursor <install|uninstall|status> [--project <dir>]');
  }
}

async function main(): Promise<void> {
  const [cmd, ...args] = process.argv.slice(2);
  switch (cmd) {
    case 'start': {
      const ok = await ensureWorker();
      console.log(ok ? `worker running at ${workerUrl()}` : `worker failed to start; see ${paths.log()}`);
      process.exitCode = ok ? 0 : 1;
      return;
    }
    case 'stop': {
      if (!(await isHealthy())) return console.log('worker is not running');
      await request('/api/shutdown', { body: {} });
      return console.log('worker stopped');
    }
    case 'status': {
      const s = loadSettings();
      if (!(await isHealthy())) return console.log(`worker: not running (port ${s.port})\nprovider: ${s.provider} · model: ${s.model}`);
      const [health, stats] = await Promise.all([
        request('/api/health').then((r) => r.json()),
        request('/api/stats').then((r) => r.json()),
      ]);
      console.log(`worker: running · pid ${health.pid} · v${health.version} · ${workerUrl()}`);
      console.log(`provider: ${health.provider} · model: ${health.model}`);
      console.log(Object.entries(stats).map(([k, v]) => `${k}: ${v}`).join(' · '));
      return;
    }
    case 'search': {
      const project = flag(args, 'project');
      const type = flag(args, 'type');
      const limit = flag(args, 'limit');
      const q = new URLSearchParams({ query: args.join(' ') });
      if (project) q.set('project', project);
      if (type) q.set('type', type);
      if (limit) q.set('limit', limit);
      return console.log(await text(`/api/search?${q}`));
    }
    case 'show':
      return console.log(await text('/api/observations/batch', { ids: args.map(Number) }));
    case 'context': {
      const project = args[0] ?? process.cwd();
      const key = args[0] ? `project=${encodeURIComponent(project)}` : `cwd=${encodeURIComponent(project)}`;
      return console.log((await text(`/api/context?${key}`)) || '(no memory for this project yet)');
    }
    case 'logs': {
      if (!existsSync(paths.log())) return console.log('no log yet');
      const lines = readFileSync(paths.log(), 'utf8').trimEnd().split('\n');
      return console.log(lines.slice(-Number(args[0] ?? 50)).join('\n'));
    }
    case 'retry': {
      const out = JSON.parse(await text('/api/retry-failed', {}));
      return console.log(`requeued ${out.requeued} failed events`);
    }
    case 'cursor':
      return cursorCommand(args);
    case 'viewer':
      return console.log(workerUrl('/'));
    default:
      console.log(HELP);
  }
}

main().catch((err) => {
  console.error(`pace-mem: ${err.message ?? err}`);
  process.exitCode = 1;
});
