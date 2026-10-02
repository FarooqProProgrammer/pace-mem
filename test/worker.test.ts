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
