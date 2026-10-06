import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import { request, type Server } from 'node:http';
import { Store } from '../src/db/store.js';
import { Processor } from '../src/worker/processor.js';
import { createWorkerServer } from '../src/worker/server.js';
import { loadSettings } from '../src/shared/config.js';
import type { Llm } from '../src/worker/llm.js';

const settings = { ...loadSettings() };
const llm: Llm = { generate: async () => { throw new Error('unused'); } };
let store: Store;
let processor: Processor;
let server: Server;
let base: string;

const post = (path: string, body: unknown) =>
  fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

beforeAll(async () => {
  store = new Store(':memory:');
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

  it('saves memories from the agent and serves search plus context', async () => {
    const sid = 'session-1';
    const cwd = '/work/shop-api';
    expect(await (await post('/api/sessions/prompt', { session_id: sid, cwd, prompt: 'How does routing work? <private>pw=1</private>' })).json()).toMatchObject({
      prompt_number: 1,
    });
    for (const [i, tool] of ['Read', 'Grep', 'TodoWrite', 'mcp__plugin_pace-mem_pace-mem__search'].entries()) {
      const out = await (await post('/api/events', { session_id: sid, cwd, tool_name: tool, tool_use_id: `t${i}`, tool_input: { file: 'src/router.ts' }, tool_response: 'ok' })).json();
      expect(out.skipped).toBeDefined();
    }
    expect(store.stats().pending).toBe(0);
    expect(store.promptText(1, 1)).not.toContain('pw=1');

    const saved = await (
      await post('/api/memory/save', {
        session_id: sid,
        cwd,
        type: 'discovery',
        title: 'Learned how the router works',
        text: 'Routes are registered in src/router.ts.',
        facts: ['Routes live in src/router.ts'],
      })
    ).json();
    expect(saved).toMatchObject({ success: true, id: 1, project: 'shop-api' });

    await post('/api/memory/summary', {
      session_id: sid,
      cwd,
      request: 'Explain routing',
      learned: 'routes in router.ts',
      completed: 'explained',
    });

    expect(store.stats()).toMatchObject({ observations: 1, summaries: 1, pending: 0 });

    const ctx = await (await fetch(base + '/api/context?project=shop-api')).text();
    expect(ctx).toContain('Learned how the router works');
    expect(ctx).toContain('Explain routing');
    expect(ctx).toContain('save_memory');

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

  it('rejects empty memory text', async () => {
    const res = await post('/api/memory/save', { text: '   ', cwd: '/work/x' });
    expect(res.status).toBe(400);
  });
});

describe('dashboard API', () => {
  it('saves settings, applies them live, and never returns unused AI keys', async () => {
    const res = await post('/api/settings', { skipTools: ['WebSearch'], maxPayloadBytes: 8000 });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.changed).toEqual(expect.arrayContaining(['skipTools', 'maxPayloadBytes']));
    expect(body.restartRequired).toBe(false);
    expect(settings.skipTools).toContain('WebSearch');
    expect(JSON.stringify(body)).not.toContain('anthropicApiKey');
    expect(body.settings.provider).toBeUndefined();
    expect(body.settings.model).toBeUndefined();

    await post('/api/sessions/prompt', { session_id: 's-dash', cwd: '/work/dash', prompt: 'p' });
    expect(await (await post('/api/events', { session_id: 's-dash', cwd: '/work/dash', tool_name: 'WebSearch', tool_input: {}, tool_response: '' })).json()).toEqual({
      skipped: 'tool',
    });
  });

  it('rejects invalid settings with per-field issues and changes nothing', async () => {
    const before = settings.contextObservations;
    const res = await post('/api/settings', { contextObservations: -1, unknownKey: 1 });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.issues.map((i: { field: string }) => i.field)).toEqual(expect.arrayContaining(['contextObservations']));
    expect(settings.contextObservations).toBe(before);
  });

  it('flags port changes as needing a restart, and resets to defaults', async () => {
    expect((await (await post('/api/settings', { port: 39999 })).json()).restartRequired).toBe(true);
    const reset = await (await post('/api/settings/reset', {})).json();
    expect(reset.settings).toMatchObject({ contextObservations: 40, redactSecrets: true });
    expect(reset.settings.port).toBe(39999);
    expect(reset.settings.model).toBeUndefined();
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
    expect(html).not.toContain('Compression model');
    expect(html).toContain('save_memory');
  });
});
