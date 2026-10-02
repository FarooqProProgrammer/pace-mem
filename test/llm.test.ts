import { describe, expect, it } from 'vitest';
import { cliSchema, supportsEffort } from '../src/worker/llm.js';
import { ObservationBatchSchema } from '../src/worker/prompts.js';

describe('llm helpers', () => {
  it('only sends effort to models that accept it', () => {
    for (const m of ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-fable-5-1', 'claude-opus-4-5']) expect(supportsEffort(m)).toBe(true);
    for (const m of ['claude-haiku-4-5', 'claude-sonnet-4-5', 'claude-3-7-sonnet-latest']) expect(supportsEffort(m)).toBe(false);
  });

  it('strips $schema for the claude CLI validator', () => {
    const s = cliSchema(ObservationBatchSchema);
    expect(s.$schema).toBeUndefined();
    expect(s.type).toBe('object');
  });
});
