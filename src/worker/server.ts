import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { projectFromCwd, type Settings } from '../shared/config.js';
import { sanitize, stripPrivate } from '../shared/privacy.js';
import { OBSERVATION_TYPES, type SearchParams, type Store } from '../db/store.js';
import type { Processor } from './processor.js';
import { fullObservation, indexTable, sessionContext, summaryBlock } from './format.js';
import { VIEWER_HTML } from './viewer.js';
import { log } from './log.js';

export const VERSION = '0.1.0';

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

type Json = Record<string, unknown>;
type Handler = (req: { query: URLSearchParams; body: Json; raw: IncomingMessage; res: ServerResponse }) => unknown | Promise<unknown>;

/** Pre-formatted text, sent as-is instead of JSON. */
class Text {
  constructor(
    readonly body: string,
    readonly type = 'text/markdown; charset=utf-8',
  ) {}
}

const ALLOWED_HOSTS = /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/;

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

function num(v: string | null | undefined): number | undefined {
  if (v == null || v === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

/** Accepts epoch ms or anything Date can parse (e.g. 2026-10-01). */
function date(v: string | null): number | undefined {
  if (!v) return undefined;
  const n = Number(v);
  if (Number.isFinite(n)) return n;
  const t = Date.parse(v);
  return Number.isNaN(t) ? undefined : t;
}

function searchParams(q: URLSearchParams): SearchParams {
  const type = q.get('type') ?? q.get('obs_type') ?? undefined;
  if (type && !(OBSERVATION_TYPES as readonly string[]).includes(type)) {
    throw new HttpError(400, `type must be one of: ${OBSERVATION_TYPES.join(', ')}`);
  }
  return {
    query: q.get('query') ?? q.get('q') ?? undefined,
    project: q.get('project') ?? undefined,
    type,
    limit: num(q.get('limit')),
    offset: num(q.get('offset')),
    dateStart: date(q.get('dateStart')),
    dateEnd: date(q.get('dateEnd')),
  };
}

export function createWorkerServer(store: Store, processor: Processor, settings: Settings): Server {
  const skip = new Set(settings.skipTools);
  const clean = (v: unknown) => sanitize(v, { redact: settings.redactSecrets, maxBytes: settings.maxPayloadBytes });

  const sessionFor = (body: Json) => {
    const id = str(body.session_id);
    if (!id) throw new HttpError(400, 'session_id is required');
    const cwd = str(body.cwd);
    return store.ensureSession(id, str(body.project) ?? projectFromCwd(cwd), cwd);
  };

  const routes: Record<string, Handler> = {
    'GET /api/health': () => ({ ok: true, version: VERSION, pid: process.pid, provider: settings.provider, model: settings.model }),

    'GET /api/stats': () => store.stats(),

    'GET /api/projects': () => store.projects(),

    // SessionStart: the markdown Claude sees at the top of a new session.
    'GET /api/context': ({ query }) => {
      const project = query.get('project') ?? projectFromCwd(query.get('cwd') ?? undefined);
      return new Text(
        sessionContext(
          project,
          store.recentSummaries(project, settings.contextSummaries),
          store.recentObservations(project, settings.contextObservations),
        ),
      );
    },

    // UserPromptSubmit
    'POST /api/sessions/prompt': ({ body }) => {
      const prompt = stripPrivate(String(body.prompt ?? '')).trim();
      const session = sessionFor(body);
      if (!prompt) return { session_db_id: session.id, skipped: 'private' };
      const n = store.addPrompt(session.id, session.project, clean(prompt));
      return { session_db_id: session.id, prompt_number: n };
    },

    // PostToolUse
    'POST /api/events': ({ body }) => {
      const tool = str(body.tool_name);
      if (!tool) throw new HttpError(400, 'tool_name is required');
      // Our own memory lookups are not new knowledge.
      if (skip.has(tool) || tool.includes('pace-mem')) return { skipped: 'tool' };
      const session = sessionFor(body);
      const added = store.addToolEvent({
        session_id: session.id,
        project: session.project,
        tool_use_id: str(body.tool_use_id) ?? `${tool}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        tool_name: tool,
        tool_input: clean(body.tool_input),
        tool_response: clean(body.tool_response),
      });
      return { queued: added };
    },

    // Stop: Claude finished answering; summarise once the queue for this request drains.
    'POST /api/sessions/summarize': ({ body }) => {
      const session = sessionFor(body);
      if (session.prompt_counter > 0) store.requestSummary(session.id, session.prompt_counter);
      processor.flush(session.id);
      return { ok: true };
    },

    // SessionEnd
    'POST /api/sessions/end': ({ body }) => {
      const session = sessionFor(body);
      store.endSession(session.id);
      processor.flush(session.id);
      return { ok: true };
    },

    'GET /api/search': ({ query }) => {
      const p = searchParams(query);
      const rows = store.searchObservations(p);
      const summaries = p.offset ? [] : store.searchSummaries({ ...p, limit: 3 });
      if (query.get('format') === 'json') return { observations: rows, summaries };
      const parts = [indexTable(rows, !p.project)];
      if (summaries.length) parts.push('## Matching session summaries', ...summaries.map(summaryBlock));
      parts.push('_Next: `timeline` with an ID for surrounding context, or `get_observations` for full details._');
      return new Text(parts.join('\n\n'));
    },

    'GET /api/timeline': ({ query }) => {
      let anchor = num(query.get('anchor'));
      const project = query.get('project') ?? undefined;
      if (anchor == null) {
        const q = query.get('query');
        if (!q) throw new HttpError(400, 'anchor or query is required');
        anchor = store.searchObservations({ query: q, project, limit: 1 })[0]?.id;
        if (anchor == null) return new Text('_No observation matches that query._');
      }
      const rows = store.timeline(anchor, num(query.get('depth_before')) ?? 3, num(query.get('depth_after')) ?? 3, project);
      if (query.get('format') === 'json') return rows;
      if (rows.length === 0) return new Text(`_Observation #${anchor} not found._`);
      return new Text(
        rows
          .map((r) => `${r.id === anchor ? '**→' : '  '} #${r.id} [${r.type}] ${r.title}${r.id === anchor ? '**' : ''}\n   ${r.subtitle}`)
          .join('\n'),
      );
    },

    'POST /api/observations/batch': ({ body, query }) => {
      const ids = Array.isArray(body.ids) ? body.ids.map(Number) : [];
      if (ids.length === 0) throw new HttpError(400, 'ids must be a non-empty array of observation IDs');
      const rows = store.getObservations(ids, str(body.project));
      if (query.get('format') === 'json') return rows;
      return new Text(rows.length ? rows.map(fullObservation).join('\n\n---\n\n') : '_No observations with those IDs._');
    },

    // Viewer paging: newest first.
    'GET /api/observations': ({ query }) =>
      store.observationsBefore(num(query.get('before')) ?? Number.MAX_SAFE_INTEGER, query.get('project') ?? undefined, Math.min(num(query.get('limit')) ?? 50, 200)),

    'GET /api/summaries': ({ query }) => store.recentSummaries(query.get('project') ?? '', Math.min(num(query.get('limit')) ?? 10, 50)),

    'GET /api/stream': ({ raw, res }) => {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
      res.write(': connected\n\n');
      const send = (event: string) => (data: unknown) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      const onObs = send('observation');
      const onSummary = send('summary');
      processor.on('observation', onObs);
      processor.on('summary', onSummary);
      const ping = setInterval(() => res.write(': ping\n\n'), 25_000);
      raw.on('close', () => {
        clearInterval(ping);
        processor.off('observation', onObs);
        processor.off('summary', onSummary);
      });
      return STREAMING;
    },

    'POST /api/retry-failed': () => ({ requeued: store.retryFailed() }),

    'POST /api/shutdown': () => {
      setTimeout(() => process.emit('SIGTERM'), 50);
      return { ok: true };
    },

    'GET /': () => new Text(VIEWER_HTML, 'text/html; charset=utf-8'),
  };

  return createServer(async (raw, res) => {
    try {
      // Reject DNS-rebinding and cross-site requests: only local hosts, JSON bodies.
      if (!ALLOWED_HOSTS.test(raw.headers.host ?? '')) throw new HttpError(403, 'forbidden host');
      const url = new URL(raw.url ?? '/', 'http://127.0.0.1');
      const handler = routes[`${raw.method} ${url.pathname}`];
      if (!handler) throw new HttpError(404, 'not found');
      let body: Json = {};
      if (raw.method === 'POST') {
        if (!raw.headers['content-type']?.startsWith('application/json')) throw new HttpError(415, 'expected application/json');
        body = await readJson(raw);
      }
      const out = await handler({ query: url.searchParams, body, raw, res });
      if (out === STREAMING) return;
      if (out instanceof Text) {
        res.writeHead(200, { 'content-type': out.type });
        res.end(out.body);
      } else {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(out));
      }
    } catch (err) {
      const status = err instanceof HttpError ? err.status : 500;
      if (status === 500) log(`request ${raw.method} ${raw.url} failed: ${(err as Error).stack ?? err}`);
      if (!res.headersSent) res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: (err as Error).message }));
    }
  });
}

const STREAMING = Symbol('streaming');

const MAX_BODY = 2 * 1024 * 1024;

function readJson(req: IncomingMessage): Promise<Json> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new HttpError(413, 'body too large'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => {
      try {
        const v = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
        resolve(v && typeof v === 'object' && !Array.isArray(v) ? v : {});
      } catch {
        reject(new HttpError(400, 'invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}
