import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import { request, type Server } from 'node:http';
import { z } from 'zod';
import { Store } from '../src/db/store.js';
import { Processor } from '../src/worker/processor.js';
import { createWorkerServer } from '../src/worker/server.js';
import { LlmError, type Llm, type LlmRequest } from '../src/worker/llm.js';
import { loadSettings } from '../src/shared/config.js';

/** Stands in for the model: one observation per batch, summaries echo the request. */
class FakeLlm implements Llm {
  calls: string[] = [];
  failNext = 0;
  async generate<T extends z.ZodType>(req: LlmRequest<T>): Promise<z.infer<T>> {
    this.calls.push(req.prompt);
    if (this.failNext > 0) {
      this.failNext--;
      throw new LlmError('provider down');
    }
    if (req.prompt.includes('<event')) {
      const n = (req.prompt.match(/<event /g) ?? []).length;
      return {
        observations: [
          {
            type: 'discovery',
            title: 'Learned how the router works',
            subtitle: `${n} events`,
            narrative: 'Routes are registered in src/router.ts.',
            facts: ['Routes live in src/router.ts'],
            concepts: ['routing'],
            files_read: ['src/router.ts'],
            files_modified: [],
            source_events: Array.from({ length: n }, (_, i) => i),
          },
        ],
      } as z.infer<T>;
    }
    return { request: 'Explain routing', investigated: 'router', learned: 'routes in router.ts', completed: 'explained', next_steps: '' } as z.infer<T>;
  }
}

const settings = { ...loadSettings(), batchSize: 3, batchDelaySeconds: 0 };
let store: Store;
let llm: FakeLlm;
let processor: Processor;
let server: Server;
let base: string;

const post = (path: string, body: unknown) =>
  fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

beforeAll(async () => {
  store = new Store(':memory:');
  llm = new FakeLlm();
  processor = new Processor(store, llm, settings);
  server = createWorkerServer(store, processor, settings);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => {
  server.closeAllConnections();
  server.close();
});

describe('worker API', () => {
  it('rejects foreign hosts and non-JSON posts', async () => {
    // fetch() won't send a custom Host header, so use node:http directly.
    const status = await new Promise<number>((resolve, reject) => {
      const url = new URL(base + '/api/stats');
      request({ host: url.hostname, port: url.port, path: url.pathname, headers: { host: 'evil.example.com' } }, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      })
        .on('error', reject)
        .end();
    });
    expect(status).toBe(403);
    const form = await fetch(base + '/api/events', { method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{}' });
    expect(form.status).toBe(415);
  });

  it('runs the full hook lifecycle: prompt → tools → stop → context → search', async () => {
    const sid = 'session-1';
    const cwd = '/work/shop-api';
    expect(await (await post('/api/sessions/prompt', { session_id: sid, cwd, prompt: 'How does routing work? <private>pw=1</private>' })).json()).toMatchObject({
      prompt_number: 1,
    });
    for (const [i, tool] of ['Read', 'Grep', 'TodoWrite', 'mcp__plugin_pace-mem_pace-mem__search'].entries()) {
      await post('/api/events', { session_id: sid, cwd, tool_name: tool, tool_use_id: `t${i}`, tool_input: { file: 'src/router.ts' }, tool_response: 'ok' });
    }
    expect(store.stats().pending).toBe(2); // skip-listed and own tools are ignored
    expect(store.promptText(1, 1)).not.toContain('pw=1');

    await post('/api/sessions/summarize', { session_id: sid, cwd });
    await processor.tick(true);
    await processor.tick(true); // summary runs once the queue has drained

    expect(store.stats()).toMatchObject({ observations: 1, summaries: 1, pending: 0 });

    const ctx = await (await fetch(base + '/api/context?project=shop-api')).text();
    expect(ctx).toContain('Learned how the router works');
    expect(ctx).toContain('Explain routing');

    const search = await (await fetch(base + '/api/search?query=router&project=shop-api')).text();
    expect(search).toMatch(/\| #1 \|/);

    const full = await (await post('/api/observations/batch', { ids: [1] })).text();
    expect(full).toContain('Routes live in src/router.ts');

    const tl = await (await fetch(base + '/api/timeline?query=router')).text();
    expect(tl).toContain('#1');
  });

  it('returns empty context for an unknown project', async () => {
    expect(await (await fetch(base + '/api/context?project=nothing-here')).text()).toBe('');
  });

  it('validates search type', async () => {
    expect((await fetch(base + '/api/search?type=bogus')).status).toBe(400);
  });

  it('keeps events queued when the model fails, and recovers', async () => {
    const sid = 'session-2';
    await post('/api/sessions/prompt', { session_id: sid, cwd: '/work/x', prompt: 'p' });
    await post('/api/events', { session_id: sid, cwd: '/work/x', tool_name: 'Bash', tool_use_id: 'b1', tool_input: 'ls', tool_response: '' });
    llm.failNext = 1;
    await processor.tick(true);
    expect(store.stats().pending).toBe(1);
    await processor.tick(true);
    expect(store.stats().pending).toBe(0);
  });
});

describe('dashboard API', () => {
  it('saves settings, applies them live, and never returns the API key', async () => {
    const res = await post('/api/settings', { model: 'claude-haiku-4-5', batchSize: 7, skipTools: ['WebSearch'], anthropicApiKey: 'sk-ant-test-1234' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.changed).toEqual(expect.arrayContaining(['model', 'batchSize', 'skipTools', 'anthropicApiKey']));
    expect(body.restartRequired).toBe(false);
    expect(settings.batchSize).toBe(7); // same object the processor reads
    expect(settings.anthropicApiKey).toBe('sk-ant-test-1234');

    const read = await (await fetch(base + '/api/settings')).json();
    expect(JSON.stringify(read)).not.toContain('sk-ant-test-1234');
    expect(read.settings).toMatchObject({ hasApiKey: true, apiKeyHint: '…1234', model: 'claude-haiku-4-5' });

    // Skip list edits apply to the next event without a restart.
    await post('/api/sessions/prompt', { session_id: 's-dash', cwd: '/work/dash', prompt: 'p' });
    expect(await (await post('/api/events', { session_id: 's-dash', cwd: '/work/dash', tool_name: 'WebSearch', tool_input: {}, tool_response: '' })).json()).toEqual({
      skipped: 'tool',
    });

    await post('/api/settings', { anthropicApiKey: '' });
    expect(settings.anthropicApiKey).toBeUndefined();
  });

  it('rejects invalid settings with per-field issues and changes nothing', async () => {
    const before = settings.batchSize;
    const res = await post('/api/settings', { batchSize: 0, provider: 'openai', unknownKey: 1 });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.issues.map((i: { field: string }) => i.field)).toEqual(expect.arrayContaining(['batchSize', 'provider']));
    expect(settings.batchSize).toBe(before);
  });

  it('flags port changes as needing a restart, and resets to defaults', async () => {
    expect((await (await post('/api/settings', { port: 39999 })).json()).restartRequired).toBe(true);
    const reset = await (await post('/api/settings/reset', {})).json();
    expect(reset.settings).toMatchObject({ batchSize: 15, model: 'claude-opus-5-5' });
    expect(reset.settings.port).toBe(39999); // reset never moves the running worker
  });

  it('deletes single observations and whole projects (with confirmation)', async () => {
    const sess = store.ensureSession('s-del', 'to-delete');
    const id = store.insertObservation({
      session_id: sess.id, project: 'to-delete', prompt_number: 1, type: 'change', title: 'Temp', subtitle: '', narrative: '',
      facts: [], concepts: [], files_read: [], files_modified: [],
    });
    store.insertObservation({
      session_id: sess.id, project: 'to-delete', prompt_number: 1, type: 'change', title: 'Temp 2', subtitle: '', narrative: '',
      facts: [], concepts: [], files_read: [], files_modified: [],
    });
    expect(await (await post('/api/observations/delete', { ids: [id] })).json()).toEqual({ deleted: 1 });
    expect(store.searchObservations({ query: 'Temp', project: 'to-delete' })).toHaveLength(1);

    expect((await post('/api/projects/delete', { project: 'to-delete', confirm: 'nope' })).status).toBe(400);
    expect(await (await post('/api/projects/delete', { project: 'to-delete', confirm: 'to-delete' })).json()).toEqual({ deleted: 1 });
    const stats = await (await fetch(base + '/api/projects/stats')).json();
    expect(stats.find((p: { project: string }) => p.project === 'to-delete')).toBeUndefined();
  });

  it('serves the dashboard', async () => {
    const html = await (await fetch(base + '/')).text();
    for (const tab of ['memories', 'settings', 'integrations', 'status']) expect(html).toContain(`data-tab="${tab}"`);
  });
});
