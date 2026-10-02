import { appendFileSync, statSync, renameSync } from 'node:fs';
import { paths } from '../shared/config.js';

const MAX_LOG_BYTES = 5 * 1024 * 1024;

export function log(message: string): void {
  const line = `${new Date().toISOString()} ${message}\n`;
  try {
    const file = paths.log();
    try {
      if (statSync(file).size > MAX_LOG_BYTES) renameSync(file, `${file}.1`);
    } catch {
      // No log file yet.
    }
    appendFileSync(file, line);
  } catch {
    // Logging must never crash the worker.
  }
  if (process.env.PACE_MEM_LOG_STDOUT) process.stdout.write(line);
}
