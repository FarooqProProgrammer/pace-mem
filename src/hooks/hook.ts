/**
 * Hook entry point, hook JSON on stdin:
 *   node hook.mjs <event>                 Claude Code (session-start, prompt, post-tool, stop, session-end)
 *   node hook.mjs cursor <cursorHookName> Cursor (sessionStart, beforeSubmitPrompt, postToolUse, stop, sessionEnd)
 *
 * Hooks must never break or slow down the user's session, so every path ends
 * in exit 0 with valid output, and calls to the worker are short and fire-and-forget.
 */
import { DISABLE_ENV, projectFromCwd } from '../shared/config.js';
import { truncate, toText } from '../shared/privacy.js';
import { ensureWorker, isHealthy, request } from '../shared/worker-client.js';
import { HOSTS, claudeCode, type Host, type MemEvent, type MemInput } from './hosts.js';

// Keep request bodies well under the worker's limit; the worker truncates further.
const MAX_FIELD = 256_000;

async function readStdin(): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  const text = Buffer.concat(chunks).toString('utf8');
  return text.trim() ? JSON.parse(text) : {};
}

async function send(path: string, body: unknown): Promise<void> {
  // If the worker died mid-session, bring it back for the next event.
  if (!(await isHealthy(300))) {
    if (!(await ensureWorker(3000))) return;
  }
  await request(path, { body, timeoutMs: 2000 }).catch(() => undefined);
}

/** Runs one event; returns the context to inject (session-start only). */
async function run(event: MemEvent, i: MemInput, host: Host): Promise<string | undefined> {
  switch (event) {
    case 'session-start': {
      if (!(await ensureWorker())) return;
      const project = projectFromCwd(i.cwd);
      const res = await request(`/api/context?project=${encodeURIComponent(project)}`, { timeoutMs: 5000 });
      return res.ok ? (await res.text()) || undefined : undefined;
    }
    case 'prompt':
      if (!i.session_id) return;
      return void (await send('/api/sessions/prompt', { session_id: i.session_id, cwd: i.cwd, prompt: i.prompt }));
    case 'post-tool':
      if (!i.session_id || !i.tool_name || host.isOwnTool(i.tool_name)) return;
      return void (await send('/api/events', {
        session_id: i.session_id,
        cwd: i.cwd,
        tool_name: i.tool_name,
        tool_use_id: i.tool_use_id,
        tool_input: truncate(toText(i.tool_input), MAX_FIELD),
        tool_response: truncate(toText(i.tool_response), MAX_FIELD),
      }));
    case 'stop':
      if (!i.session_id) return;
      return void (await send('/api/sessions/summarize', { session_id: i.session_id, cwd: i.cwd }));
    case 'session-end':
      if (!i.session_id) return;
      return void (await send('/api/sessions/end', { session_id: i.session_id, cwd: i.cwd }));
  }
}

async function main(): Promise<string> {
  const args = process.argv.slice(2);
  const host = HOSTS[args[0]] && args.length > 1 ? HOSTS[args.shift()!] : claudeCode;
  const event = host.event(args[0] ?? '');
  if (!event) return '';
  let context: string | undefined;
  try {
    // The worker's own `claude -p` calls run with this set; never record them.
    if (process.env[DISABLE_ENV] !== '1') context = await run(event, host.normalize(await readStdin()), host);
  } catch (err) {
    if (process.env.PACE_MEM_DEBUG) process.stderr.write(`pace-mem hook: ${(err as Error)?.stack ?? err}\n`);
  }
  return host.reply(event, context);
}

// Exit only after stdout flushes: a pipe write can be cut off by an immediate exit.
main()
  .catch(() => '')
  .then((out) => (out ? process.stdout.write(out, () => process.exit(0)) : process.exit(0)));
