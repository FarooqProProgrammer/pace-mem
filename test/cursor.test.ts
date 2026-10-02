import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { claudeCode, cursor } from '../src/hooks/hosts.js';
import { CURSOR_HOOKS, cursorStatus, hookCommand, installCursor, mergeHooks, uninstallCursor } from '../src/cli/cursor.js';

// Shape of the claude-mem entries found in a real ~/.cursor/hooks.json.
const CLAUDE_MEM_HOOKS = {
  version: 1,
  hooks: {
    beforeSubmitPrompt: [{ command: '& "C:\\bun.exe" "C:\\claude-mem\\worker-service.cjs" hook cursor session-init' }],
    stop: [{ command: '& "C:\\bun.exe" "C:\\claude-mem\\worker-service.cjs" hook cursor summarize' }],
  },
};

describe('cursor host adapter', () => {
  it('maps Cursor hook names to internal events', () => {
    expect(cursor.event('sessionStart')).toBe('session-start');
    expect(cursor.event('beforeSubmitPrompt')).toBe('prompt');
    expect(cursor.event('postToolUse')).toBe('post-tool');
    expect(cursor.event('stop')).toBe('stop');
    expect(cursor.event('sessionEnd')).toBe('session-end');
    expect(cursor.event('afterFileEdit')).toBeUndefined();
  });

  it('normalizes the payload: conversation id, workspace root, tool_output', () => {
    const input = cursor.normalize({
      conversation_id: 'conv-1',
      session_id: 'sess-9',
      workspace_roots: ['/work/shop-api'],
      cwd: '/work/shop-api/packages/web',
      tool_name: 'Shell',
      tool_input: { command: 'npm test' },
      tool_output: '{"exitCode":0}',
      tool_use_id: 'tu1',
    });
    expect(input).toMatchObject({
      session_id: 'conv-1',
      cwd: '/work/shop-api',
      tool_name: 'Shell',
      tool_response: '{"exitCode":0}',
      tool_use_id: 'tu1',
    });
  });

  it('always replies with JSON Cursor accepts', () => {
    expect(JSON.parse(cursor.reply('session-start', '# memory'))).toEqual({ additional_context: '# memory' });
    expect(JSON.parse(cursor.reply('session-start'))).toEqual({});
    expect(JSON.parse(cursor.reply('prompt'))).toEqual({ continue: true });
    expect(JSON.parse(cursor.reply('post-tool'))).toEqual({});
  });

  it("skips pace-mem's own MCP tools", () => {
    expect(cursor.isOwnTool('MCP:search')).toBe(true);
    expect(cursor.isOwnTool('MCP:get_observations')).toBe(true);
    expect(cursor.isOwnTool('Shell')).toBe(false);
  });

  it('keeps the Claude Code adapter unchanged', () => {
    expect(claudeCode.event('post-tool')).toBe('post-tool');
    expect(JSON.parse(claudeCode.reply('session-start', 'ctx')).hookSpecificOutput.additionalContext).toBe('ctx');
    expect(claudeCode.reply('prompt')).toBe('');
  });
});

describe('cursor installer', () => {
  const target = { nodePath: 'C:\\Program Files\\nodejs\\node.exe', runtimeDir: 'C:\\Users\\a\\.pace-mem\\runtime', platform: 'win32' as const };

  it('builds PowerShell commands on Windows and sh commands elsewhere', () => {
    expect(hookCommand(target, 'stop')).toBe('& "C:\\Program Files\\nodejs\\node.exe" "C:\\Users\\a\\.pace-mem\\runtime\\hook.mjs" cursor stop');
    expect(hookCommand({ nodePath: '/usr/bin/node', runtimeDir: '/home/a/.pace-mem/runtime', platform: 'linux' }, 'stop')).toMatch(
      /^"\/usr\/bin\/node" ".*hook\.mjs" cursor stop$/,
    );
  });

  it('adds its hooks next to other tools and is idempotent', () => {
    const once = mergeHooks(CLAUDE_MEM_HOOKS, target);
    const twice = mergeHooks(once, target);
    expect(twice).toEqual(once);
    expect(once.hooks!.beforeSubmitPrompt).toHaveLength(2);
    expect(once.hooks!.beforeSubmitPrompt[0].command).toContain('claude-mem');
    expect(Object.keys(once.hooks!).sort()).toEqual([...new Set([...CURSOR_HOOKS.map((h) => h.event), 'beforeSubmitPrompt', 'stop'])].sort());
  });

  it('installs, reports status and uninstalls without touching other entries', () => {
    const root = mkdtempSync(join(tmpdir(), 'pace-mem-cursor-'));
    const cursorDir = join(root, '.cursor');
    const sourceDir = join(root, 'scripts');
    mkdirSync(cursorDir);
    mkdirSync(sourceDir);
    for (const f of ['hook.mjs', 'worker.mjs', 'mcp.mjs', 'cli.mjs']) writeFileSync(join(sourceDir, f), '// built');
    writeFileSync(join(cursorDir, 'hooks.json'), JSON.stringify(CLAUDE_MEM_HOOKS));
    writeFileSync(join(cursorDir, 'mcp.json'), JSON.stringify({ mcpServers: { 'claude-mem': { command: 'node', args: ['x'] } } }));

    // Deliberately no "pace-mem" in the path: entries must be recognised by their command.
    const runtimeDir = join(root, 'data', 'runtime');
    const result = installCursor({ cursorDir, runtimeDir, sourceDir, nodePath: process.execPath, platform: process.platform });
    expect(result.others).toContain('claude-mem');
    expect(existsSync(join(runtimeDir, 'hook.mjs'))).toBe(true);
    expect(existsSync(join(cursorDir, 'hooks.json.pace-mem.bak'))).toBe(true);
    const status = cursorStatus(cursorDir);
    expect(status.mcp).toBe(true);
    expect(status.hooks.sort()).toEqual(CURSOR_HOOKS.map((h) => h.event).sort());

    uninstallCursor(cursorDir);
    expect(JSON.parse(readFileSync(join(cursorDir, 'hooks.json'), 'utf8')).hooks).toEqual(CLAUDE_MEM_HOOKS.hooks);
    expect(Object.keys(JSON.parse(readFileSync(join(cursorDir, 'mcp.json'), 'utf8')).mcpServers)).toEqual(['claude-mem']);
    expect(cursorStatus(cursorDir)).toEqual({ hooks: [], mcp: false });
  });

  it('refuses to overwrite an unparseable hooks.json', () => {
    const root = mkdtempSync(join(tmpdir(), 'pace-mem-cursor-'));
    writeFileSync(join(root, 'hooks.json'), '{ broken');
    expect(() =>
      installCursor({ cursorDir: root, runtimeDir: join(root, 'rt'), sourceDir: root, nodePath: 'node', platform: 'linux' }),
    ).toThrow(/not valid JSON/);
    expect(readFileSync(join(root, 'hooks.json'), 'utf8')).toBe('{ broken');
  });
});
