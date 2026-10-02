import { EventEmitter } from 'node:events';
import type { Settings } from '../shared/config.js';
import type { ObservationRow, Store, SummaryRow } from '../db/store.js';
import { LlmError, type Llm } from './llm.js';
import { OBSERVER_SYSTEM, ObservationBatchSchema, SUMMARY_SYSTEM, SummarySchema, observerPrompt, summaryPrompt } from './prompts.js';
import { log } from './log.js';

const MAX_ATTEMPTS = 3;

export interface ProcessorEvents {
  observation: [ObservationRow];
  summary: [SummaryRow];
}

/**
 * Drains the tool-event queue into observations, then writes summaries once a
 * request's events are all processed. One model call runs at a time.
 */
export class Processor extends EventEmitter<ProcessorEvents> {
  private busy = false;
  private timer?: NodeJS.Timeout;
  /** Sessions whose queue should be flushed now, without waiting for the batch delay. */
  private readonly flushNow = new Set<number>();
  /** Backoff after a failed model call, so a broken provider isn't hammered every second. */
  private readonly retryAt = new Map<number, number>();

  constructor(
    private readonly store: Store,
    private readonly llm: Llm,
    private readonly settings: Settings,
  ) {
    super();
  }

  start(intervalMs = 1000): void {
    const requeued = this.store.requeueStale();
    if (requeued) log(`requeued ${requeued} events left in flight by a previous worker`);
    this.timer = setInterval(() => void this.tick(), intervalMs);
  }

  stop(): void {
    clearInterval(this.timer);
  }

  flush(sessionId: number): void {
    this.flushNow.add(sessionId);
    void this.tick();
  }

  /** One pass over the queue. Public so tests can drive it deterministically. */
  async tick(force = false): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      for (const p of this.store.pendingBySession()) {
        if (!force && (this.retryAt.get(p.session_id) ?? 0) > Date.now()) continue;
        const due =
          force ||
          this.flushNow.has(p.session_id) ||
          p.count >= this.settings.batchSize ||
          Date.now() - p.newest >= this.settings.batchDelaySeconds * 1000;
        if (due) await this.compressBatch(p.session_id);
      }
      for (const s of this.store.summaryRequests()) {
        if (!this.store.hasPendingEvents(s.id, s.summary_requested_for!)) await this.summarize(s.id, s.summary_requested_for!);
      }
    } catch (err) {
      log(`processor tick failed: ${(err as Error).stack ?? err}`);
    } finally {
      this.busy = false;
    }
  }

  private async compressBatch(sessionId: number): Promise<void> {
    const events = this.store.claimEvents(sessionId, this.settings.batchSize);
    if (events.length === 0) {
      this.flushNow.delete(sessionId);
      return;
    }
    const { project, prompt_number } = events[0];
    const ids = events.map((e) => e.id);
    try {
      const batch = await this.llm.generate({
        system: OBSERVER_SYSTEM,
        prompt: observerPrompt({ project, userPrompt: this.store.promptText(sessionId, prompt_number), events }),
        schema: ObservationBatchSchema,
      });
      const links = new Map<number, number>();
      for (const o of batch.observations) {
        if (!o.title.trim()) continue;
        const id = this.store.insertObservation({ ...o, session_id: sessionId, project, prompt_number });
        for (const idx of o.source_events) if (events[idx]) links.set(events[idx].id, id);
        this.emit('observation', this.store.getObservations([id])[0]);
      }
      this.store.finishEvents(ids, links);
      this.retryAt.delete(sessionId);
      log(`session ${sessionId}: ${events.length} events -> ${batch.observations.length} observations`);
    } catch (err) {
      // A permanent failure (refusal, invalid output) won't improve on retry.
      this.store.releaseEvents(ids, err instanceof LlmError && err.permanent ? 0 : MAX_ATTEMPTS);
      this.retryAt.set(sessionId, Date.now() + 30_000 * events[0].attempts);
      log(`session ${sessionId}: compression failed: ${(err as Error).message}`);
    }
  }

  private async summarize(sessionId: number, promptNumber: number): Promise<void> {
    const session = this.store.getSession(sessionId);
    if (!session) return;
    const since = this.store.lastSummaryPrompt(sessionId);
    const observations: ObservationRow[] = [];
    for (let n = since + 1; n <= promptNumber; n++) observations.push(...this.store.observationsForPrompt(sessionId, n));
    if (observations.length === 0) {
      // Nothing happened worth summarising (e.g. a pure Q&A turn).
      this.store.clearSummaryRequest(sessionId, promptNumber);
      return;
    }
    try {
      const prompts = [];
      for (let n = since + 1; n <= promptNumber; n++) prompts.push(this.store.promptText(sessionId, n));
      const s = await this.llm.generate({
        system: SUMMARY_SYSTEM,
        prompt: summaryPrompt({ project: session.project, userPrompt: prompts.filter(Boolean).join('\n---\n'), observations }),
        schema: SummarySchema,
      });
      const id = this.store.insertSummary({ ...s, session_id: sessionId, project: session.project, prompt_number: promptNumber });
      this.store.clearSummaryRequest(sessionId, promptNumber);
      this.emit('summary', { ...s, id, session_id: sessionId, project: session.project, prompt_number: promptNumber, created_at: Date.now() });
      log(`session ${sessionId}: summary for prompts ${since + 1}-${promptNumber}`);
    } catch (err) {
      log(`session ${sessionId}: summary failed: ${(err as Error).message}`);
      if (err instanceof LlmError && err.permanent) this.store.clearSummaryRequest(sessionId, promptNumber);
    }
  }
}
