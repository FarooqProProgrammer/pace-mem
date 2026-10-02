import { describe, expect, it } from 'vitest';
import { Store, toFtsQuery, type ObservationInput } from '../src/db/store.js';

function obs(store: Store, sessionId: number, over: Partial<ObservationInput> = {}): number {
  return store.insertObservation({
    session_id: sessionId,
    project: 'app',
    prompt_number: 1,
    type: 'bugfix',
    title: 'Fixed token expiry in auth middleware',
    subtitle: 'Tokens expired after 1h instead of 24h',
    narrative: 'The JWT expiry was read in seconds but configured in minutes.',
    facts: ['TOKEN_TTL is in minutes'],
    concepts: ['auth', 'jwt'],
    files_read: ['src/auth/config.ts'],
    files_modified: ['src/auth/middleware.ts'],
    ...over,
  });
}

describe('Store', () => {
  it('maps the same Claude session id to the same row and numbers prompts', () => {
    const s = new Store(':memory:');
    const a = s.ensureSession('abc', 'app', '/x/app');
    const b = s.ensureSession('abc', 'app', '/x/app');
    expect(a.id).toBe(b.id);
    expect(s.addPrompt(a.id, 'app', 'first')).toBe(1);
    expect(s.addPrompt(a.id, 'app', 'second')).toBe(2);
    expect(s.promptText(a.id, 2)).toBe('second');
  });

  it('dedupes tool events by tool_use_id and claims one prompt at a time', () => {
    const s = new Store(':memory:');
    const sess = s.ensureSession('abc', 'app');
    s.addPrompt(sess.id, 'app', 'p1');
    const ev = { session_id: sess.id, project: 'app', tool_name: 'Read', tool_input: '{}', tool_response: 'x' };
    expect(s.addToolEvent({ ...ev, tool_use_id: 't1' })).toBe(true);
    expect(s.addToolEvent({ ...ev, tool_use_id: 't1' })).toBe(false);
    s.addToolEvent({ ...ev, tool_use_id: 't2' });
    s.addPrompt(sess.id, 'app', 'p2');
    s.addToolEvent({ ...ev, tool_use_id: 't3' });

    const first = s.claimEvents(sess.id, 10);
    expect(first.map((e) => e.tool_use_id)).toEqual(['t1', 't2']);
    expect(first.every((e) => e.prompt_number === 1)).toBe(true);
    expect(s.claimEvents(sess.id, 10).map((e) => e.tool_use_id)).toEqual(['t3']);
  });

  it('retries failed events, then gives up', () => {
    const s = new Store(':memory:');
    const sess = s.ensureSession('abc', 'app');
    s.addToolEvent({ session_id: sess.id, project: 'app', tool_use_id: 't', tool_name: 'Bash', tool_input: '', tool_response: '' });
    for (let i = 0; i < 2; i++) {
      const [e] = s.claimEvents(sess.id, 5);
      s.releaseEvents([e.id], 3);
      expect(s.stats().pending).toBe(1);
    }
    const [e] = s.claimEvents(sess.id, 5);
    s.releaseEvents([e.id], 3);
    expect(s.stats()).toMatchObject({ pending: 0, failed: 1 });
  });

  it('requeues events left in processing by a crashed worker', () => {
    const s = new Store(':memory:');
    const sess = s.ensureSession('abc', 'app');
    s.addToolEvent({ session_id: sess.id, project: 'app', tool_use_id: 't', tool_name: 'Bash', tool_input: '', tool_response: '' });
    s.claimEvents(sess.id, 5);
    expect(s.requeueStale()).toBe(1);
    expect(s.claimEvents(sess.id, 5)).toHaveLength(1);
  });

  it('searches observations with stemming, filters and AND→OR fallback', () => {
    const s = new Store(':memory:');
    const sess = s.ensureSession('abc', 'app');
    const id = obs(s, sess.id);
    obs(s, sess.id, {
      title: 'Added dark mode toggle',
      subtitle: 'Theme follows the OS setting',
      type: 'feature',
      narrative: 'CSS variables',
      concepts: ['ui'],
      facts: [],
      files_read: [],
      files_modified: ['src/theme.css'],
    });
    obs(s, sess.id, { project: 'other', title: 'Token refresh in other project' });

    expect(s.searchObservations({ query: 'expired tokens', project: 'app' }).map((r) => r.id)).toEqual([id]);
    expect(s.searchObservations({ query: 'token', type: 'feature' })).toHaveLength(0);
    expect(s.searchObservations({ query: 'middleware.ts', project: 'app' }).map((r) => r.id)).toEqual([id]);
    // No row has both words, so OR matching kicks in.
    expect(s.searchObservations({ query: 'dark jwt', project: 'app' })).toHaveLength(2);
    expect(s.searchObservations({ query: 'token' })).toHaveLength(2);
  });

  it('treats FTS syntax in queries as plain text', () => {
    const s = new Store(':memory:');
    const sess = s.ensureSession('abc', 'app');
    obs(s, sess.id);
    for (const q of ['"', 'title:auth', 'auth OR', 'NEAR(a b)', "'); DROP TABLE observations; --", '*', 'a AND NOT']) {
      expect(() => s.searchObservations({ query: q })).not.toThrow();
    }
    expect(s.stats().observations).toBe(1);
    expect(toFtsQuery('title:auth "x"')).toBe('"title" "auth"');
    expect(toFtsQuery('!!!')).toBeNull();
  });

  it('builds a timeline around an anchor within the project', () => {
    const s = new Store(':memory:');
    const sess = s.ensureSession('abc', 'app');
    const ids = Array.from({ length: 7 }, (_, i) => obs(s, sess.id, { title: `step ${i}` }));
    obs(s, sess.id, { project: 'other', title: 'elsewhere' });
    expect(s.timeline(ids[3], 2, 2).map((r) => r.id)).toEqual(ids.slice(1, 6));
    expect(s.timeline(9999, 2, 2)).toEqual([]);
  });
});
