import { DatabaseSync, type SQLInputValue } from 'node:sqlite';

import type { ObservationType } from '../shared/types.js';

export { OBSERVATION_TYPES, type ObservationType } from '../shared/types.js';

export interface SessionRow {
  id: number;
  content_session_id: string;
  project: string;
  cwd: string | null;
  status: 'active' | 'completed';
  prompt_counter: number;
  summary_requested_for: number | null;
  started_at: number;
  ended_at: number | null;
  last_activity_at: number;
}

export interface ToolEventRow {
  id: number;
  session_id: number;
  project: string;
  prompt_number: number;
  tool_use_id: string;
  tool_name: string;
  tool_input: string;
  tool_response: string;
  status: 'pending' | 'processing' | 'done' | 'failed';
  attempts: number;
  observation_id: number | null;
  created_at: number;
}

export interface ObservationInput {
  session_id: number;
  project: string;
  prompt_number: number;
  type: ObservationType;
  title: string;
  subtitle: string;
  narrative: string;
  facts: string[];
  concepts: string[];
  files_read: string[];
  files_modified: string[];
}

export interface ObservationRow extends Omit<ObservationInput, 'facts' | 'concepts' | 'files_read' | 'files_modified'> {
  id: number;
  facts: string;
  concepts: string;
  files_read: string;
  files_modified: string;
  created_at: number;
}

export interface SummaryInput {
  session_id: number;
  project: string;
  prompt_number: number;
  request: string;
  investigated: string;
  learned: string;
  completed: string;
  next_steps: string;
}

export interface SummaryRow extends SummaryInput {
  id: number;
  created_at: number;
}

export interface SearchParams {
  query?: string;
  project?: string;
  type?: string;
  limit?: number;
  offset?: number;
  dateStart?: number;
  dateEnd?: number;
}

const SCHEMA_VERSION = 1;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  content_session_id TEXT NOT NULL UNIQUE,
  project TEXT NOT NULL,
  cwd TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  prompt_counter INTEGER NOT NULL DEFAULT 0,
  summary_requested_for INTEGER,
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  last_activity_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_project ON sessions(project, started_at DESC);

CREATE TABLE IF NOT EXISTS user_prompts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id INTEGER NOT NULL REFERENCES sessions(id),
  project TEXT NOT NULL,
  prompt_number INTEGER NOT NULL,
  prompt_text TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_prompts_session ON user_prompts(session_id, prompt_number);

-- Raw tool calls. Doubles as the compression queue (status) and the durable record.
CREATE TABLE IF NOT EXISTS tool_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id INTEGER NOT NULL REFERENCES sessions(id),
  project TEXT NOT NULL,
  prompt_number INTEGER NOT NULL,
  tool_use_id TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  tool_input TEXT NOT NULL,
  tool_response TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  observation_id INTEGER,
  created_at INTEGER NOT NULL,
  UNIQUE(session_id, tool_use_id)
);
CREATE INDEX IF NOT EXISTS idx_events_status ON tool_events(status, session_id, id);

CREATE TABLE IF NOT EXISTS observations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id INTEGER NOT NULL REFERENCES sessions(id),
  project TEXT NOT NULL,
  prompt_number INTEGER NOT NULL,
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  subtitle TEXT NOT NULL DEFAULT '',
  narrative TEXT NOT NULL DEFAULT '',
  facts TEXT NOT NULL DEFAULT '[]',
  concepts TEXT NOT NULL DEFAULT '[]',
  files_read TEXT NOT NULL DEFAULT '[]',
  files_modified TEXT NOT NULL DEFAULT '[]',
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_obs_project ON observations(project, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_obs_type ON observations(type);

CREATE VIRTUAL TABLE IF NOT EXISTS observations_fts USING fts5(
  title, subtitle, narrative, facts, concepts, files,
  content='', contentless_delete=1, tokenize='porter unicode61'
);
CREATE TRIGGER IF NOT EXISTS observations_ai AFTER INSERT ON observations BEGIN
  INSERT INTO observations_fts(rowid, title, subtitle, narrative, facts, concepts, files)
  VALUES (new.id, new.title, new.subtitle, new.narrative, new.facts, new.concepts, new.files_read || ' ' || new.files_modified);
END;
CREATE TRIGGER IF NOT EXISTS observations_ad AFTER DELETE ON observations BEGIN
  DELETE FROM observations_fts WHERE rowid = old.id;
END;

CREATE TABLE IF NOT EXISTS summaries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id INTEGER NOT NULL REFERENCES sessions(id),
  project TEXT NOT NULL,
  prompt_number INTEGER NOT NULL,
  request TEXT NOT NULL DEFAULT '',
  investigated TEXT NOT NULL DEFAULT '',
  learned TEXT NOT NULL DEFAULT '',
  completed TEXT NOT NULL DEFAULT '',
  next_steps TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_summaries_project ON summaries(project, created_at DESC);

CREATE VIRTUAL TABLE IF NOT EXISTS summaries_fts USING fts5(
  request, investigated, learned, completed, next_steps,
  content='', contentless_delete=1, tokenize='porter unicode61'
);
CREATE TRIGGER IF NOT EXISTS summaries_ai AFTER INSERT ON summaries BEGIN
  INSERT INTO summaries_fts(rowid, request, investigated, learned, completed, next_steps)
  VALUES (new.id, new.request, new.investigated, new.learned, new.completed, new.next_steps);
END;
CREATE TRIGGER IF NOT EXISTS summaries_ad AFTER DELETE ON summaries BEGIN
  DELETE FROM summaries_fts WHERE rowid = old.id;
END;
`;

/**
 * Turns free text into a safe FTS5 expression: every token becomes a quoted
 * string, so user input can never inject FTS operators or column filters.
 */
export function toFtsQuery(query: string, mode: 'AND' | 'OR' = 'AND'): string | null {
  const tokens = query.match(/[\p{L}\p{N}_.\-/]+/gu)?.filter((t) => t.length > 1 || /\p{N}/u.test(t)) ?? [];
  if (tokens.length === 0) return null;
  return tokens.map((t) => `"${t.replace(/"/g, '""')}"`).join(mode === 'AND' ? ' ' : ' OR ');
}

const now = () => Date.now();

export class Store {
  readonly db: DatabaseSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;');
    this.db.exec(SCHEMA);
    this.db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
  }

  close(): void {
    this.db.close();
  }

  private all<T>(sql: string, ...params: SQLInputValue[]): T[] {
    return this.db.prepare(sql).all(...params) as T[];
  }

  private get<T>(sql: string, ...params: SQLInputValue[]): T | undefined {
    return this.db.prepare(sql).get(...params) as T | undefined;
  }

  private tx<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const out = fn();
      this.db.exec('COMMIT');
      return out;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  // ── sessions & prompts ────────────────────────────────────────────────

  /** Idempotent: the same Claude Code session id always maps to the same row. */
  ensureSession(contentSessionId: string, project: string, cwd?: string): SessionRow {
    const t = now();
    this.db
      .prepare(
        `INSERT INTO sessions (content_session_id, project, cwd, started_at, last_activity_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(content_session_id) DO UPDATE SET last_activity_at = excluded.last_activity_at, status = 'active'`,
      )
      .run(contentSessionId, project, cwd ?? null, t, t);
    return this.get<SessionRow>('SELECT * FROM sessions WHERE content_session_id = ?', contentSessionId)!;
  }

  getSession(id: number): SessionRow | undefined {
    return this.get<SessionRow>('SELECT * FROM sessions WHERE id = ?', id);
  }

  /** Prefer an explicit session, else the latest active one for the project, else a manual bucket. */
  sessionForWrite(project: string, contentSessionId?: string, cwd?: string): SessionRow {
    if (contentSessionId) return this.ensureSession(contentSessionId, project, cwd);
    const active = this.get<SessionRow>(
      `SELECT * FROM sessions WHERE project = ? AND status = 'active' ORDER BY last_activity_at DESC LIMIT 1`,
      project,
    );
    if (active) return active;
    return this.ensureSession(`manual:${project}`, project, cwd);
  }

  /** Records a prompt and returns its 1-based number within the session. */
  addPrompt(sessionId: number, project: string, text: string): number {
    return this.tx(() => {
      const row = this.get<{ prompt_counter: number }>(
        'UPDATE sessions SET prompt_counter = prompt_counter + 1, last_activity_at = ? WHERE id = ? RETURNING prompt_counter',
        now(),
        sessionId,
      )!;
      this.db
        .prepare('INSERT INTO user_prompts (session_id, project, prompt_number, prompt_text, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(sessionId, project, row.prompt_counter, text, now());
      return row.prompt_counter;
    });
  }

  promptText(sessionId: number, promptNumber: number): string | undefined {
    return this.get<{ prompt_text: string }>(
      'SELECT prompt_text FROM user_prompts WHERE session_id = ? AND prompt_number = ?',
      sessionId,
      promptNumber,
    )?.prompt_text;
  }

  endSession(sessionId: number): void {
    this.db.prepare(`UPDATE sessions SET status = 'completed', ended_at = ? WHERE id = ?`).run(now(), sessionId);
  }

  // ── tool event queue ──────────────────────────────────────────────────

  /** Returns false when the event was already recorded (hook retries are harmless). */
  addToolEvent(e: Pick<ToolEventRow, 'session_id' | 'project' | 'tool_use_id' | 'tool_name' | 'tool_input' | 'tool_response'>): boolean {
    const session = this.getSession(e.session_id);
    const res = this.db
      .prepare(
        `INSERT OR IGNORE INTO tool_events (session_id, project, prompt_number, tool_use_id, tool_name, tool_input, tool_response, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(e.session_id, e.project, session?.prompt_counter ?? 0, e.tool_use_id, e.tool_name, e.tool_input, e.tool_response, now());
    return res.changes > 0;
  }

  /** Sessions with queued events, with the timing the processor needs to decide when to flush. */
  pendingBySession(): { session_id: number; count: number; newest: number }[] {
    return this.all(
      `SELECT session_id, COUNT(*) AS count, MAX(created_at) AS newest
       FROM tool_events WHERE status = 'pending' GROUP BY session_id ORDER BY MIN(id)`,
    );
  }

  /** Atomically moves up to `limit` pending events of one prompt into `processing`. */
  claimEvents(sessionId: number, limit: number): ToolEventRow[] {
    return this.tx(() => {
      const first = this.get<{ prompt_number: number }>(
        `SELECT prompt_number FROM tool_events WHERE session_id = ? AND status = 'pending' ORDER BY id LIMIT 1`,
        sessionId,
      );
      if (!first) return [];
      return this.all<ToolEventRow>(
        `UPDATE tool_events SET status = 'processing', attempts = attempts + 1
         WHERE id IN (SELECT id FROM tool_events WHERE session_id = ? AND prompt_number = ? AND status = 'pending' ORDER BY id LIMIT ?)
         RETURNING *`,
        sessionId,
        first.prompt_number,
        limit,
      ).sort((a, b) => a.id - b.id);
    });
  }

  finishEvents(ids: number[], links: Map<number, number> = new Map()): void {
    const stmt = this.db.prepare(`UPDATE tool_events SET status = 'done', observation_id = ? WHERE id = ?`);
    this.tx(() => ids.forEach((id) => stmt.run(links.get(id) ?? null, id)));
  }

  /** Puts events back in the queue, or gives up on them after `maxAttempts`. */
  releaseEvents(ids: number[], maxAttempts: number): void {
    const stmt = this.db.prepare(
      `UPDATE tool_events SET status = CASE WHEN attempts >= ? THEN 'failed' ELSE 'pending' END WHERE id = ?`,
    );
    this.tx(() => ids.forEach((id) => stmt.run(maxAttempts, id)));
  }

  /** Crash recovery: anything left mid-flight by a previous worker goes back to the queue. */
  requeueStale(): number {
    return Number(this.db.prepare(`UPDATE tool_events SET status = 'pending' WHERE status = 'processing'`).run().changes);
  }

  /** Gives events that ran out of attempts another chance (e.g. after fixing provider auth). */
  retryFailed(): number {
    return this.tx(() => {
      // Summaries for these sessions were skipped while their events had failed; ask again.
      this.db.exec(
        `UPDATE sessions SET summary_requested_for = prompt_counter
         WHERE id IN (SELECT DISTINCT session_id FROM tool_events WHERE status = 'failed')`,
      );
      return Number(this.db.prepare(`UPDATE tool_events SET status = 'pending', attempts = 0 WHERE status = 'failed'`).run().changes);
    });
  }

  hasPendingEvents(sessionId: number, promptNumber: number): boolean {
    return !!this.get(
      `SELECT 1 FROM tool_events WHERE session_id = ? AND prompt_number <= ? AND status IN ('pending','processing') LIMIT 1`,
      sessionId,
      promptNumber,
    );
  }

  // ── observations & summaries ──────────────────────────────────────────

  insertObservation(o: ObservationInput): number {
    const res = this.db
      .prepare(
        `INSERT INTO observations (session_id, project, prompt_number, type, title, subtitle, narrative, facts, concepts, files_read, files_modified, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        o.session_id,
        o.project,
        o.prompt_number,
        o.type,
        o.title,
        o.subtitle,
        o.narrative,
        JSON.stringify(o.facts),
        JSON.stringify(o.concepts),
        JSON.stringify(o.files_read),
        JSON.stringify(o.files_modified),
        now(),
      );
    return Number(res.lastInsertRowid);
  }

  requestSummary(sessionId: number, promptNumber: number): void {
    this.db.prepare('UPDATE sessions SET summary_requested_for = ? WHERE id = ?').run(promptNumber, sessionId);
  }

  summaryRequests(): SessionRow[] {
    return this.all<SessionRow>('SELECT * FROM sessions WHERE summary_requested_for IS NOT NULL ORDER BY last_activity_at');
  }

  clearSummaryRequest(sessionId: number, promptNumber: number): void {
    // Only clear if no newer request arrived while the summary was being generated.
    this.db
      .prepare('UPDATE sessions SET summary_requested_for = NULL WHERE id = ? AND summary_requested_for = ?')
      .run(sessionId, promptNumber);
  }

  insertSummary(s: SummaryInput): number {
    const res = this.db
      .prepare(
        `INSERT INTO summaries (session_id, project, prompt_number, request, investigated, learned, completed, next_steps, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(s.session_id, s.project, s.prompt_number, s.request, s.investigated, s.learned, s.completed, s.next_steps, now());
    return Number(res.lastInsertRowid);
  }

  observationsForPrompt(sessionId: number, promptNumber: number): ObservationRow[] {
    return this.all('SELECT * FROM observations WHERE session_id = ? AND prompt_number = ? ORDER BY id', sessionId, promptNumber);
  }

  lastSummaryPrompt(sessionId: number): number {
    return (
      this.get<{ n: number | null }>('SELECT MAX(prompt_number) AS n FROM summaries WHERE session_id = ?', sessionId)?.n ?? 0
    );
  }

  // ── reads ─────────────────────────────────────────────────────────────

  getObservations(ids: number[], project?: string): ObservationRow[] {
    const clean = [...new Set(ids.map(Number).filter(Number.isInteger))].slice(0, 100);
    if (clean.length === 0) return [];
    const marks = clean.map(() => '?').join(',');
    const params: SQLInputValue[] = [...clean];
    let sql = `SELECT * FROM observations WHERE id IN (${marks})`;
    if (project) {
      sql += ' AND project = ?';
      params.push(project);
    }
    return this.all<ObservationRow>(`${sql} ORDER BY id`, ...params);
  }

  recentObservations(project: string, limit: number): ObservationRow[] {
    return this.all('SELECT * FROM observations WHERE project = ? ORDER BY id DESC LIMIT ?', project, limit);
  }

  recentSummaries(project: string, limit: number): SummaryRow[] {
    return this.all('SELECT * FROM summaries WHERE project = ? ORDER BY id DESC LIMIT ?', project, limit);
  }

  observationsAfter(afterId: number, project?: string, limit = 100): ObservationRow[] {
    return project
      ? this.all('SELECT * FROM observations WHERE id > ? AND project = ? ORDER BY id LIMIT ?', afterId, project, limit)
      : this.all('SELECT * FROM observations WHERE id > ? ORDER BY id LIMIT ?', afterId, limit);
  }

  /** Newest-first page for the viewer. */
  observationsBefore(beforeId: number, project: string | undefined, limit: number): ObservationRow[] {
    return project
      ? this.all('SELECT * FROM observations WHERE id < ? AND project = ? ORDER BY id DESC LIMIT ?', beforeId, project, limit)
      : this.all('SELECT * FROM observations WHERE id < ? ORDER BY id DESC LIMIT ?', beforeId, limit);
  }

  projects(): { project: string; observations: number; last_at: number }[] {
    return this.all(
      'SELECT project, COUNT(*) AS observations, MAX(created_at) AS last_at FROM observations GROUP BY project ORDER BY last_at DESC',
    );
  }

  /** Per-project counts for the dashboard, including projects with only raw events so far. */
  projectStats(): { project: string; sessions: number; observations: number; summaries: number; last_at: number }[] {
    return this.all(
      `SELECT s.project,
              COUNT(*) AS sessions,
              (SELECT COUNT(*) FROM observations o WHERE o.project = s.project) AS observations,
              (SELECT COUNT(*) FROM summaries m WHERE m.project = s.project) AS summaries,
              MAX(s.last_activity_at) AS last_at
       FROM sessions s GROUP BY s.project ORDER BY last_at DESC`,
    );
  }

  deleteObservations(ids: number[]): number {
    const clean = [...new Set(ids.map(Number).filter(Number.isInteger))];
    if (clean.length === 0) return 0;
    const marks = clean.map(() => '?').join(',');
    return this.tx(() => {
      this.db.prepare(`UPDATE tool_events SET observation_id = NULL WHERE observation_id IN (${marks})`).run(...clean);
      return Number(this.db.prepare(`DELETE FROM observations WHERE id IN (${marks})`).run(...clean).changes);
    });
  }

  /** Forgets everything recorded for a project. */
  deleteProject(project: string): number {
    return this.tx(() => {
      const removed = Number(this.db.prepare('DELETE FROM observations WHERE project = ?').run(project).changes);
      this.db.prepare('DELETE FROM summaries WHERE project = ?').run(project);
      this.db.prepare('DELETE FROM tool_events WHERE project = ?').run(project);
      this.db.prepare('DELETE FROM user_prompts WHERE project = ?').run(project);
      this.db.prepare('DELETE FROM sessions WHERE project = ?').run(project);
      return removed;
    });
  }

  stats(): Record<string, number> {
    const one = (sql: string) => Number(this.get<{ n: number }>(sql)?.n ?? 0);
    return {
      sessions: one('SELECT COUNT(*) AS n FROM sessions'),
      prompts: one('SELECT COUNT(*) AS n FROM user_prompts'),
      observations: one('SELECT COUNT(*) AS n FROM observations'),
      summaries: one('SELECT COUNT(*) AS n FROM summaries'),
      pending: one(`SELECT COUNT(*) AS n FROM tool_events WHERE status IN ('pending','processing')`),
      failed: one(`SELECT COUNT(*) AS n FROM tool_events WHERE status = 'failed'`),
    };
  }

  /** Full-text search over observations; falls back to OR matching when AND finds nothing. */
  searchObservations(p: SearchParams): ObservationRow[] {
    const limit = Math.min(Math.max(p.limit ?? 20, 1), 100);
    const offset = Math.max(p.offset ?? 0, 0);
    const filters: string[] = [];
    const params: SQLInputValue[] = [];
    if (p.project) (filters.push('o.project = ?'), params.push(p.project));
    if (p.type) (filters.push('o.type = ?'), params.push(p.type));
    if (p.dateStart) (filters.push('o.created_at >= ?'), params.push(p.dateStart));
    if (p.dateEnd) (filters.push('o.created_at <= ?'), params.push(p.dateEnd));
    const where = filters.length ? `AND ${filters.join(' AND ')}` : '';

    if (!p.query?.trim()) {
      return this.all(
        `SELECT o.* FROM observations o WHERE 1=1 ${where} ORDER BY o.id DESC LIMIT ? OFFSET ?`,
        ...params,
        limit,
        offset,
      );
    }
    for (const mode of ['AND', 'OR'] as const) {
      const fts = toFtsQuery(p.query, mode);
      if (!fts) return [];
      const rows = this.all<ObservationRow>(
        `SELECT o.* FROM observations_fts f JOIN observations o ON o.id = f.rowid
         WHERE observations_fts MATCH ? ${where}
         ORDER BY bm25(observations_fts, 8.0, 4.0, 2.0, 2.0, 3.0, 1.0) LIMIT ? OFFSET ?`,
        fts,
        ...params,
        limit,
        offset,
      );
      if (rows.length > 0 || mode === 'OR') return rows;
    }
    return [];
  }

  searchSummaries(p: SearchParams): SummaryRow[] {
    const fts = p.query ? toFtsQuery(p.query, 'OR') : null;
    if (!fts) return [];
    const params: SQLInputValue[] = [fts];
    let where = '';
    if (p.project) (where = 'AND s.project = ?'), params.push(p.project);
    return this.all(
      `SELECT s.* FROM summaries_fts f JOIN summaries s ON s.id = f.rowid
       WHERE summaries_fts MATCH ? ${where} ORDER BY bm25(summaries_fts) LIMIT ?`,
      ...params,
      Math.min(p.limit ?? 5, 20),
    );
  }

  /** Observations around an anchor in the same project, oldest first. */
  timeline(anchorId: number, before: number, after: number, project?: string): ObservationRow[] {
    const anchor = this.getObservations([anchorId])[0];
    if (!anchor) return [];
    const proj = project ?? anchor.project;
    const older = this.all<ObservationRow>(
      'SELECT * FROM observations WHERE project = ? AND id < ? ORDER BY id DESC LIMIT ?',
      proj,
      anchorId,
      before,
    ).reverse();
    const newer = this.all<ObservationRow>(
      'SELECT * FROM observations WHERE project = ? AND id > ? ORDER BY id LIMIT ?',
      proj,
      anchorId,
      after,
    );
    return [...older, anchor, ...newer];
  }
}
