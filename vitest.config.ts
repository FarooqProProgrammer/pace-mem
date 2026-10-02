import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Keep tests away from the real ~/.pace-mem.
    env: { PACE_MEM_DATA_DIR: mkdtempSync(join(tmpdir(), 'pace-mem-test-')) },
  },
});
