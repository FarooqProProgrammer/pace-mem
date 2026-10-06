import { existsSync, readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { DEFAULTS, dataDir, paths, projectFromCwd, type Settings } from '../shared/config.js';
import { cursorStatus, installCursor, uninstallCursor, userCursorDir } from '../cli/cursor.js';
import { sanitize, stripPrivate } from '../shared/privacy.js';
import { OBSERVATION_TYPES, type SearchParams, type Store } from '../db/store.js';
import type { Processor } from './processor.js';
import { publicSettings, resetSettings, saveSettings } from './settings.js';
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

/** Whether pace-mem is enabled as a Claude Code plugin (user settings). */
function claudeCodeStatus(): { installed: boolean; enabled: boolean } {
  try {
    const file = join(homedir(), '.claude', 'settings.json');
    const enabled = existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')).enabledPlugins ?? {}) : {};
    const key = Object.keys(enabled).find((k) => k.startsWith('pace-mem@'));
    return { installed: !!key, enabled: !!key && enabled[key] !== false };
  } catch {
    return { installed: false, enabled: false };
  }
}

const SaveMemorySchema = z.object({
  text: z.string().trim().min(1).max(20_000),
  title: z.string().trim().max(120).optional(),
  subtitle: z.string().trim().max(240).optional(),
  type: z.enum(OBSERVATION_TYPES).optional(),
  facts: z.array(z.string().trim().min(1).max(500)).max(40).optional(),
  concepts: z.array(z.string().trim().min(1).max(80)).max(20).optional(),
  files_read: z.array(z.string().trim().min(1).max(400)).max(50).optional(),
  files_modified: z.array(z.string().trim().min(1).max(400)).max(50).optional(),
  project: z.string().trim().min(1).max(200).optional(),
  session_id: z.string().trim().min(1).optional(),
  cwd: z.string().optional(),
});

const SaveSummarySchema = z.object({
  request: z.string().trim().max(2_000).optional(),
  investigated: z.string().trim().max(4_000).optional(),
  learned: z.string().trim().max(4_000).optional(),
  completed: z.string().trim().max(4_000).optional(),
  next_steps: z.string().trim().max(2_000).optional(),
  project: z.string().trim().min(1).max(200).optional(),
  session_id: z.string().trim().min(1).optional(),
  cwd: z.string().optional(),
});

function headline(text: string, title?: string): string {
  const line = (title?.trim() || text.trim().split(/\n/)[0] || 'Memory').replace(/\s+/g, ' ');
  return line.length > 80 ? `${line.slice(0, 77)}…` : line;
}

export function createWorkerServer(store: Store, processor: Processor, settings: Settings): Server {
  const clean = (v: unknown) => sanitize(v, { redact: settings.redactSecrets, maxBytes: settings.maxPayloadBytes });

  const sessionFor = (body: Json) => {
    const id = str(body.session_id);
    if (!id) throw new HttpError(400, 'session_id is required');
    const cwd = str(body.cwd);
    return store.ensureSession(id, str(body.project) ?? projectFromCwd(cwd), cwd);
  };

  const routes: Record<string, Handler> = {
    'GET /api/health': () => ({ ok: true, version: VERSION, pid: process.pid }),

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

    // PostToolUse: tool calls are not compressed. The agent writes memories via MCP.
    'POST /api/events': ({ body }) => {
      const tool = str(body.tool_name);
      if (!tool) throw new HttpError(400, 'tool_name is required');
      if (settings.skipTools.includes(tool) || tool.includes('pace-mem')) return { skipped: 'tool' };
      return { skipped: 'agent-memory' };
    },

    'POST /api/sessions/summarize': ({ body }) => {
      sessionFor(body);
      return { ok: true };
    },

    'POST /api/memory/save': ({ body }) => {
      const parsed = SaveMemorySchema.parse(body);
      const narrative = String(clean(stripPrivate(parsed.text))).trim();
      if (!narrative) throw new HttpError(400, 'text is empty after privacy filters');
      const project = parsed.project || projectFromCwd(parsed.cwd);
      const session = store.sessionForWrite(project, parsed.session_id, parsed.cwd);
      const id = store.insertObservation({
        session_id: session.id,
        project: session.project,
        prompt_number: session.prompt_counter,
        type: parsed.type ?? 'discovery',
        title: headline(narrative, parsed.title ? String(clean(parsed.title)) : undefined),
        subtitle: parsed.subtitle ? String(clean(parsed.subtitle)) : '',
        narrative,
        facts: (parsed.facts ?? []).map((f) => String(clean(f))),
        concepts: parsed.concepts ?? [],
        files_read: parsed.files_read ?? [],
        files_modified: parsed.files_modified ?? [],
      });
      const row = store.getObservations([id])[0];
      processor.emit('observation', row);
      log(`saved observation #${id} for ${session.project}`);
      return { success: true, id, title: row.title, project: session.project, message: `Memory saved as observation #${id}` };
    },

    'POST /api/memory/summary': ({ body }) => {
      const parsed = SaveSummarySchema.parse(body);
      const fields = {
        request: parsed.request ? String(clean(stripPrivate(parsed.request))) : '',
        investigated: parsed.investigated ? String(clean(parsed.investigated)) : '',
        learned: parsed.learned ? String(clean(parsed.learned)) : '',
        completed: parsed.completed ? String(clean(parsed.completed)) : '',
        next_steps: parsed.next_steps ? String(clean(parsed.next_steps)) : '',
      };
      if (!fields.request && !fields.learned && !fields.completed) {
        throw new HttpError(400, 'provide request, learned, or completed');
      }
      const project = parsed.project || projectFromCwd(parsed.cwd);
      const session = store.sessionForWrite(project, parsed.session_id, parsed.cwd);
      const id = store.insertSummary({
        ...fields,
        session_id: session.id,
        project: session.project,
        prompt_number: session.prompt_counter,
      });
      const row = { ...fields, id, session_id: session.id, project: session.project, prompt_number: session.prompt_counter, created_at: Date.now() };
      processor.emit('summary', row);
      log(`saved summary #${id} for ${session.project}`);
      return { success: true, id, project: session.project, message: `Summary saved as #${id}` };
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

    // ── dashboard: settings ──────────────────────────────────────────────
    'GET /api/settings': () => ({
      settings: publicSettings(settings),
      defaults: publicSettings(DEFAULTS),
      paths: { data: dataDir(), db: paths.db(), settings: paths.settings(), log: paths.log() },
      // Environment variables win over the settings file at the next worker start.
      envOverrides: { port: 'PACE_MEM_PORT' } as Record<string, string>,
      activeEnvOverrides: ['PACE_MEM_PORT'].filter((k) => process.env[k]),
    }),

    'POST /api/settings': ({ body }) => {
      const result = saveSettings(settings, body);
      log(`settings updated: ${result.changed.join(', ') || 'no changes'}`);
      return { ...result, settings: publicSettings(settings) };
    },

    'POST /api/settings/reset': () => {
      resetSettings(settings);
      log('settings reset to defaults');
      return { settings: publicSettings(settings) };
    },

    // ── dashboard: data ──────────────────────────────────────────────────
    'GET /api/projects/stats': () => store.projectStats(),

    'POST /api/observations/delete': ({ body }) => {
      const ids = Array.isArray(body.ids) ? body.ids.map(Number) : [];
      if (ids.length === 0) throw new HttpError(400, 'ids must be a non-empty array');
      return { deleted: store.deleteObservations(ids) };
    },

    'POST /api/projects/delete': ({ body }) => {
      const project = str(body.project);
      if (!project) throw new HttpError(400, 'project is required');
      if (body.confirm !== project) throw new HttpError(400, 'confirm must repeat the project name');
      log(`deleted all memory for project ${project}`);
      return { deleted: store.deleteProject(project) };
    },

    // ── dashboard: integrations ──────────────────────────────────────────
    'GET /api/integrations': () => ({
      claudeCode: claudeCodeStatus(),
      cursor: { ...cursorStatus(userCursorDir()), dir: userCursorDir() },
    }),

    'POST /api/integrations/cursor/install': () => {
      const result = installCursor({
        cursorDir: userCursorDir(),
        runtimeDir: join(dataDir(), 'runtime'),
        // The worker bundle sits next to the other bundled scripts.
        sourceDir: fileURLToPath(new URL('.', import.meta.url)),
        nodePath: process.execPath,
        platform: process.platform,
      });
      log('installed Cursor integration');
      return { ...result, status: cursorStatus(userCursorDir()) };
    },

    'POST /api/integrations/cursor/uninstall': () => {
      uninstallCursor(userCursorDir());
      log('removed Cursor integration');
      return { status: cursorStatus(userCursorDir()) };
    },

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
      if (err instanceof z.ZodError) {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'invalid request', issues: err.issues.map((i) => ({ field: i.path.join('.'), message: i.message })) }));
        return;
      }
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
