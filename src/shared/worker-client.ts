import { spawn } from 'node:child_process';
import { openSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { paths, workerUrl } from './config.js';

export async function request(path: string, init: { method?: string; body?: unknown; timeoutMs?: number } = {}): Promise<Response> {
  return fetch(workerUrl(path), {
    method: init.method ?? (init.body === undefined ? 'GET' : 'POST'),
    headers: init.body === undefined ? undefined : { 'content-type': 'application/json' },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
    signal: AbortSignal.timeout(init.timeoutMs ?? 5000),
  });
}

export async function isHealthy(timeoutMs = 1000): Promise<boolean> {
  try {
    return (await request('/api/health', { timeoutMs })).ok;
  } catch {
    return false;
  }
}

/** All bundled scripts live side by side in plugin/scripts. */
function workerScript(): string {
  return fileURLToPath(new URL('./worker.mjs', import.meta.url));
}

export function spawnWorker(): void {
  const out = openSync(paths.log(), 'a');
  const child = spawn(process.execPath, [workerScript()], {
    detached: true,
    stdio: ['ignore', out, out],
    windowsHide: true,
  });
  child.unref();
}

/** Starts the worker if it isn't running and waits until it answers. */
export async function ensureWorker(waitMs = 8000): Promise<boolean> {
  if (await isHealthy()) return true;
  spawnWorker();
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 200));
    if (await isHealthy(500)) return true;
  }
  return false;
}
